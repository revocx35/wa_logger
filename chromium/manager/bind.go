package main

import (
	"net"
	"sync"
)

// onLinkAddress returns this container's address on the network it shares with the peer (the app container), or ""
// while the peer does not resolve to an address on one of our own networks.
//
// The API must listen there and nowhere else: not on the egress network (the internet side), and not on the address
// a search domain may turn the name into before the peer exists (Docker's DNS then forwards to the host's resolver).
// An address is only accepted when it lies inside one of our interfaces' subnets, i.e. it is directly reachable.
func onLinkAddress(peer string) string {
	ips, err := net.LookupIP(peer)
	if err != nil {
		return ""
	}
	ifaces, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	var nets []*net.IPNet
	var own []net.IP
	for _, a := range ifaces {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() {
			nets = append(nets, n)
			own = append(own, n.IP)
		}
	}
	return pickOnLink(ips, nets, own)
}

var bindMu sync.Mutex

// pickOnLink: the interface address that shares a subnet with one of the peer's addresses.
func pickOnLink(peer []net.IP, nets []*net.IPNet, own []net.IP) string {
	bindMu.Lock()
	defer bindMu.Unlock()
	for _, p := range peer {
		if p4 := p.To4(); p4 != nil {
			for i, n := range nets {
				if n.IP.To4() != nil && n.Contains(p4) && !own[i].Equal(p4) {
					return own[i].String()
				}
			}
		}
	}
	return ""
}
