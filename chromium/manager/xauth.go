package main

import (
	"crypto/rand"
	"encoding/binary"
	"strconv"
)

// xauthority builds an Xauthority file with one MIT-MAGIC-COOKIE-1 entry for the display. The wildcard family
// (65535) matches whatever hostname the client uses, so it works in any container.
func xauthority(display int) (file []byte, err error) {
	cookie := make([]byte, 16)
	if _, err = rand.Read(cookie); err != nil {
		return nil, err
	}
	var b []byte
	put := func(v []byte) {
		b = binary.BigEndian.AppendUint16(b, uint16(len(v)))
		b = append(b, v...)
	}
	b = binary.BigEndian.AppendUint16(b, 0xFFFF) // FamilyWild
	put(nil)                                     // address
	put([]byte(strconv.Itoa(display)))           // display number
	put([]byte("MIT-MAGIC-COOKIE-1"))
	put(cookie)
	return b, nil
}
