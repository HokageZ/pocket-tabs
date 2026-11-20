'use strict';
const os = require('os');

const VIRTUAL = /(vethernet|virtual|vmware|vbox|hyper-?v|wsl|docker|loopback|bluetooth|tailscale|zerotier|vpn|\btap\b|\btun\b|npcap|teredo|isatap|hamachi|radmin)/i;

/** LAN IPv4 addresses of this PC, most likely "the Wi-Fi your phone is on" first. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const ip = a.address;
      let score = 0;
      if (ip.startsWith('169.254.')) score -= 100;
      if (ip.startsWith('192.168.')) score += 30;
      else if (ip.startsWith('10.')) score += 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score += 10;
      if (/wi-?fi|wlan|wireless/i.test(name)) score += 15;
      else if (/ethernet|^eth|^en/i.test(name)) score += 10;
      if (VIRTUAL.test(name)) score -= 40;
      out.push({ name, address: ip, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

module.exports = { lanAddresses };
