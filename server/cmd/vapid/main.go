// Command vapid prints a fresh VAPID keypair, which is what a deployment needs
// before the bell can reach a closed tab.
//
// Run once, per deployment, and keep the answer. The keypair is this server's
// permanent name to every browser push service: every subscription a device
// hands over is bound to the public half, so replacing it silently invalidates
// all of them — silently, because a browser has no way of being told.
package main

import (
	"fmt"
	"os"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func main() {
	private, public, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		fmt.Fprintln(os.Stderr, "vapid:", err)
		os.Exit(1)
	}
	fmt.Printf("VAPID_PUBLIC_KEY=%s\n", public)
	fmt.Printf("VAPID_PRIVATE_KEY=%s\n", private)
	fmt.Println("VAPID_SUBJECT=mailto:you@example.com")
}
