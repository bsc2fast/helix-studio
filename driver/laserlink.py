"""
laserlink — is the laser there, and if not, where did it go?

  probe(host)        -> True when the laser's LPD port (515) accepts a connection
  scan(extra_hosts)  -> every host on the local /24 networks answering on 515

The Epilog speaks LPD and nothing else we can rely on, so "online" means
"port 515 accepts a TCP connection" — exactly what a send needs. The probe
connects and closes without sending a byte, which LPD servers treat as a
no-op (it is also how CUPS checks an LPD queue).

The scan sweeps the /24 around each of this machine's IPv4 addresses (plus the
/24 of any host we were told about, e.g. the configured laser IP) with a
short-timeout connect per address, in parallel. Any LPD printer answers on
515, so a scan can return an office printer too — the caller decides.
"""

import ipaddress
import re
import socket
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

LPD_PORT = 515


def probe(host, port=LPD_PORT, timeout=1.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def local_ipv4():
    """This machine's non-loopback, non-link-local IPv4 addresses. Stdlib has
    no interface list, so read it from the OS tool."""
    cmds = ([["ipconfig"]] if sys.platform == "win32"
            else [["ip", "-4", "-o", "addr"], ["ifconfig"]])
    text = ""
    for cmd in cmds:
        try:
            text = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        if text:
            break
    addrs = set()
    for a in re.findall(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])", text):
        try:
            ip = ipaddress.IPv4Address(a)
        except ValueError:
            continue
        if not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified
                or a.endswith(".255") or a.endswith(".0") or a.startswith("255.")):
            addrs.add(a)
    return sorted(addrs)


def scan(extra_hosts=(), port=LPD_PORT, timeout=0.5, workers=128):
    mine = set(local_ipv4())
    nets = []
    for a in list(mine) + [h for h in extra_hosts if h]:
        try:
            net = ipaddress.IPv4Network(a + "/24", strict=False)
        except ValueError:
            continue
        if net not in nets:
            nets.append(net)
    candidates = [str(ip) for net in nets for ip in net.hosts() if str(ip) not in mine]
    with ThreadPoolExecutor(max_workers=workers) as ex:
        up = list(ex.map(lambda h: probe(h, port, timeout), candidates))
    return {"found": [h for h, ok in zip(candidates, up) if ok],
            "networks": [str(n) for n in nets]}
