# Device frames (optional real artwork)

Drop a PNG named after the device type here to replace the CSS placeholder
bezel with the real device body:

    assets/frames/465.png   # Redmi Watch 5  (also used for 565 / Redmi Watch 6)
    assets/frames/562.png   # Mi Watch S5
    ...

Requirements:

- One PNG per device type. Aspect should match the **screen** aspect
  (e.g. 432×514 for 465/565); it is stretched to the frame box, which is the
  screen plus the small CSS padding ring.
- Draw the device body (bezel, buttons, crown) and leave the screen area
  **transparent** so the canvas shows through, OR paint a neutral backdrop.
- Redmi Watch 5 and Redmi Watch 6 share the same shell — a single
  `465.png` covers both (add `565.png` only if they ever diverge).

Missing file => the generated SVG mask (`assets/masks/<type>.svg`) plus the
CSS gradient bezel is used. No code change is needed when you add artwork.
