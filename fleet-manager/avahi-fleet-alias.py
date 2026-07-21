#!/usr/bin/env python3
"""
avahi-fleet-alias — publish a generic mDNS name (default: fleet-manager.local)
for THIS machine's live LAN address(es), so rovers can always reach the Fleet
Manager at a fixed role name regardless of which computer is hosting it or what
IP/subnet the LAN happens to use today.

Why an A record and not a CNAME:
  Raspberry Pi OS resolves .local names via `mdns4_minimal`, which does NOT
  chase CNAMEs. So a `fleet-manager.local -> <host>.local` CNAME would fail to
  resolve on the rovers. We therefore publish a direct A record, scoped per
  network interface (exactly how avahi handles its own hostname), so a rover
  querying on its subnet gets back the FM's address on that same subnet.

The record tracks the machine's address: when DHCP renumbers the LAN (e.g.
192.168.31.x -> 192.168.10.x) or you switch Wi-Fi <-> Ethernet, the alias
follows automatically. VPN / virtual / loopback interfaces are ignored.

Requires: avahi-daemon running, python3-dbus. No third-party packages.
"""

import os
import re
import signal
import socket
import subprocess
import sys
import time

import dbus

ALIAS = os.environ.get("FLEET_ALIAS", "fleet-manager.local").rstrip(".")
POLL_SECONDS = int(os.environ.get("FLEET_ALIAS_POLL", "20"))
TTL = 60

# avahi / DNS constants
PROTO_INET = 0          # AVAHI_PROTO_INET
CLASS_IN = 0x01
TYPE_A = 0x01

# Interfaces we never advertise on (VPNs, containers, bridges, loopback, ...).
SKIP_PREFIXES = ("lo", "tun", "tap", "wg", "ppp", "docker", "virbr", "veth",
                 "br-", "vmnet", "zt", "tailscale")


def is_private(ip):
    o = [int(x) for x in ip.split(".")]
    return (o[0] == 10
            or (o[0] == 192 and o[1] == 168)
            or (o[0] == 172 and 16 <= o[1] <= 31))


def current_targets():
    """Return a sorted set of (ifindex, ip) for private LAN IPv4 addresses."""
    out = subprocess.check_output(["ip", "-o", "-4", "addr", "show"],
                                  text=True)
    targets = set()
    for line in out.splitlines():
        # "<idx>: <ifname>    inet <ip>/<prefix> ..."
        m = re.match(r"\s*\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/", line)
        if not m:
            continue
        ifname, ip = m.group(1), m.group(2)
        if ifname.startswith(SKIP_PREFIXES):
            continue
        if not is_private(ip):
            continue
        try:
            idx = socket.if_nametoindex(ifname)
        except OSError:
            continue
        targets.add((idx, ip))
    return frozenset(targets)


def ip_to_rdata(ip):
    return [dbus.Byte(b) for b in socket.inet_aton(ip)]


class Publisher:
    def __init__(self):
        self.bus = dbus.SystemBus()
        self.server = dbus.Interface(
            self.bus.get_object("org.freedesktop.Avahi", "/"),
            "org.freedesktop.Avahi.Server")
        self.group = None
        self.published = None

    def _new_group(self):
        path = self.server.EntryGroupNew()
        return dbus.Interface(self.bus.get_object("org.freedesktop.Avahi", path),
                              "org.freedesktop.Avahi.EntryGroup")

    def publish(self, targets):
        if self.group is not None:
            self.group.Reset()
        else:
            self.group = self._new_group()
        for idx, ip in sorted(targets):
            # AddRecord(interface, protocol, flags, name, class, type, ttl, rdata)
            self.group.AddRecord(idx, PROTO_INET, dbus.UInt32(0),
                                 ALIAS, CLASS_IN, TYPE_A, TTL,
                                 ip_to_rdata(ip))
        self.group.Commit()
        self.published = targets

    def clear(self):
        if self.group is not None:
            try:
                self.group.Reset()
                self.group.Free()
            except dbus.DBusException:
                pass
            self.group = None
            self.published = None


def main():
    pub = Publisher()

    def shutdown(*_):
        pub.clear()
        print("avahi-fleet-alias: stopped", flush=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"avahi-fleet-alias: advertising '{ALIAS}' "
          f"(poll every {POLL_SECONDS}s)", flush=True)

    while True:
        try:
            targets = current_targets()
            if targets != pub.published:
                if targets:
                    pub.publish(targets)
                    pretty = ", ".join(f"{ip}@if{idx}"
                                       for idx, ip in sorted(targets))
                    print(f"avahi-fleet-alias: {ALIAS} -> {pretty}", flush=True)
                else:
                    pub.clear()
                    print("avahi-fleet-alias: no LAN address, alias cleared",
                          flush=True)
        except (subprocess.CalledProcessError, dbus.DBusException) as e:
            print(f"avahi-fleet-alias: transient error: {e}", flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
