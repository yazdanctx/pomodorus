// The web app manifest, which is what makes the app installable: a dock icon
// on a desktop, a home-screen icon on a phone, and a window of its own with no
// browser chrome around it.
//
// Generated from copy.json rather than written out as a static file in
// `public/`, exactly as v1 generated it from the same source — the app's name
// and its one-line description are copy, and copy has one home.
//
// Imported relatively rather than through the `@` alias: this module is read
// by vite.config.ts at build time, outside the app's own module graph, where
// that alias does not resolve.
import copy from "./copy.json";

export const manifest = {
  name: copy.app.name,
  short_name: copy.app.name,
  description: copy.app.description,
  lang: "fa",
  dir: "rtl",

  // The installed app opens straight into the timer. The landing page
  // explains what this is to somebody who has never seen it, and a person
  // who put the app on their home screen is past that.
  start_url: "/app",
  scope: "/",
  display: "standalone",

  // Black, both of them: the app is monochrome on black, and a splash or a
  // status bar in any other colour is a flash of something the app never is.
  background_color: "#000000",
  theme_color: "#000000",

  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    // The same mark drawn into the central 80%, so a platform that crops the
    // icon to its own shape crops padding rather than the tomato.
    {
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
} as const;

/** The bytes served at /manifest.webmanifest, in dev and in the build. */
export const manifestJSON = JSON.stringify(manifest, null, 2);
