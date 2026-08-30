# Roof Cut Planner

Plots the polycarbonate pieces for a four-sided conservatory roof and works out
which sheets to order so the cuts nest together.

Static site, vanilla ES modules and SVG — no build step and no dependencies,
same as [Toldo](../toldo2).

```bash
node serve.mjs
# then open http://localhost:8010
```

[serve.mjs](serve.mjs) is the static site plus the one thing a plain file server
cannot do — take the measurements typed into the page and write them back to
`cuts.json`. Still no dependencies; it is node's own http module. Any static
server will do if you would rather type into the file instead:

```bash
python3 -m http.server 8010   # same page, but the boxes cannot save
```

Either way the page watches both data files and redraws within a second of a
save, so the editor and the browser can sit side by side. Half-typed JSON is
normal while editing: the status line says so and the last good drawing stays up.

`?cuts=data/example-cuts.json` loads a worked example instead of your own
measurements.

## Entering the pieces

Type them into the boxes under each piece, or edit
[data/cuts.json](data/cuts.json) directly — the two are the same numbers and each
follows the other within a second. A box saves as you leave it, the previous
contents of the file go to `data/cuts.json.bak`, and the page rewrites nothing
you did not type: side, order and the note are all kept.

**Only you and those boxes write to that file** — the sheet catalogue lives
separately in [data/sheets.json](data/sheets.json), so refreshing prices can
never touch your measurements, and `serve.mjs` refuses a PUT to anything else or
to anything that is not a cut list.

**Everything is in centimetres** — the shop quotes sheets in mm, so a 690 mm
sheet is `69` and a 2000 mm one is `200`.

Every piece is keyed `1` to `28`:

```json
"7": { "side": "south", "edges": [240.2, 52, 240.2, 69] }
```

Edges run **clockwise from the bottom-left corner**, so:

- 4 sides — `[side 1, side 2, side 3, side 4]`
- 3 sides — `[side 1, side 2, side 3]`

The last side is always the base — the edge that sits on the eave. They are
numbered rather than named because a piece can be turned or flipped, and "left"
would then describe only the way it last happened to be lying.

### Why a 4-sided piece needs an assumption

Four side lengths do not define one shape — `20,20,20,20` is a square, but it is
equally a rhombus squashed to any angle. So one angle has to be assumed, and
which one depends on where the piece sits:

1. **Top parallel to the bottom** is tried first — a panel between two glazing
   bars with the eave parallel to the ridge. It pins the shape exactly, and
   makes `20,20,20,20` a true square.
2. **Square to the base** is the fallback, for a piece cut against a hip: the
   sides run parallel up the slope, the eave meets them at a right angle, and
   the top is cut on the slant, nowhere near parallel to the bottom. All four
   measured lengths are still used exactly — an error in the measuring shows up
   as the right edge leaning off vertical rather than as a piece that cannot be
   drawn. These are captioned `hip cut`.

Three side lengths do define one shape, so triangles need no assumption.

### The width guide

A piece cut between two glazing bars is a strip of one width the whole way up,
so every 4-sided piece is drawn with a dashed line showing that width where it
matters: dropped square from the corner at the low end of the top edge onto the
side opposite it. The number on the end is what that perpendicular measures, and
it should be the base.

The four lengths over-determine the shape, so it usually is not. On
`[240, 98, 171, 69]` the guide reads 69.6 against a base of 69, and goes red —
the top is a few millimetres long, swinging the corner out. Walk the top down
with the arrows until the guide reads 69 back (97.6, here, which is
`hypot(69, 240 - 171)` — the arrows step in whole centimetres, so the last
tenth has to be typed) and the piece is square between the bars.

Nothing is rewritten for you, and the shape drawn is always the one your
measurements make. The guide is a second opinion, not a correction.

The guide is drawn on trapezoids too, and on a piece that genuinely narrows
towards the ridge — one with a top parallel to its base — it will read red and
should be ignored.

If neither shape closes, the piece is still drawn, from the **nearest edge
lengths that do close** — the top redrawn so the sides run parallel, or all the
edges pulled the shortest distance (least squares) that satisfies the triangle
inequality, whichever moves the numbers less. Those pieces are dashed and
captioned `fitted`, listed under Problems with the correction spelled out, and
bordered red — where a piece that closes on the numbers as typed is bordered
green, updated on every keystroke and every click of the arrows, so a correction
can be walked in until the border turns. Only leaving the box saves it, and
**Show fitted sizes** puts the fitted numbers on the drawing. The panel also
prints the whole file with those numbers swapped in, to copy back into
`cuts.json` once you have checked them against the roof. The measurements
themselves are never rewritten for you.

A piece too big for every sheet in the catalogue — piece 12 at 222 cm wide, say,
against a widest sheet of 210 — is set aside and listed under Problems. The rest
of the roof is nested as usual.

## Sheets

[data/sheets.json](data/sheets.json) is the real catalogue — all 53 in-stock variants of the
[Axiome Clear 16 mm sheet](https://clearambershop.com/products/axiome-clear-16mm-multiwall-polycarbonate-roofing-sheet),
read from the shop on 2026-08-28. `id` keeps the shop's mm label so you can order
against it; `width` and `length` are the same sheet in cm; `price` is pounds
**inc VAT**:

```json
{ "id": "690x2500mm", "width": 69, "length": 250, "price": 34.86 }
```

| Width | Lengths available (mm) |
| --- | --- |
| 690 | 1000, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000 |
| 840 | 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000 |
| 1050 | 1000, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000 |
| 1250 | 2000, 2500, 3000, 3500, 4000, 4500, 5000 |
| 1400 | 2000, 2500, 3000, 3500, 4000, 4500, 5000 |
| 1700 | 2000, 2500, 3000, 3500, 4000 |
| 2100 | 1000, 2000, 2500, 3000, 3500, 4000 |

**Every variant costs the same £20.20/m², from the 690×1000 to the 2100×4000.**
There is no bulk discount for buying a bigger sheet, which is worth knowing: it
means offcut converts straight into money at a flat rate, so a percentage point
of yield is a percentage point of the bill, and choosing sheet sizes is purely
about fit. Re-read the prices before ordering — they will have moved.

Delete any row you would rather not order. If prices are removed the optimiser
falls back to minimising sheet area, which here gives the same answer.

`kerf` is the saw width lost at every cut, in cm — `0.5` for a 5 mm blade. Set it
to `0` if you are not cutting between adjacent pieces. `margin` is an unusable
strip at the sheet edge, defaulting to `0` because these widths are meant to be
used whole.

## The roof from above

The **Roof** tab lays every side onto its own eave — west and east facing each
other, north and south facing each other — with each side's pieces in numbered
order along it, 4 cm apart so the count stays visible — on the roof they butt up
against each other, but a shared line reads as one shape from above. The
numbering runs anticlockwise from the west side, which is the order the pieces
are in.

Nothing is fitted or squared up to make it look right: a piece sits at the length
of its own base, so a gap or an overlap between two of them is two measurements
disagreeing, and the dashed rectangle is what the four eaves enclose. Opposite
eaves that do not come to the same length are the first thing to look at.

Every edge carries its length, so a gap can be read against the two numbers that
caused it without leaving the view.

**Click any piece to open it on its own** — drawn large, with a box per edge
named `left / top / right / bottom`. The drawing follows as you type, green while
the lengths close into a real piece and red when they do not. **OK** writes them
to `data/cuts.json` and redraws everything; **Close** (and Escape, and the
backdrop) throws the change away. The edit is held on a copy until OK, so backing
out really does leave the file alone — unlike the boxes on the **Pieces** tab,
which save the moment you leave them.

## Asking a model instead

The nester is greedy and predictable, which is most of what you want, but it
leaves slack a person looking at the shapes can sometimes use. The **Ask a
model** tab is that second opinion, done by hand because the page is static and
cannot call anything:

1. **Copy the prompt.** It carries every piece as coordinates, the sheet
   catalogue with prices, and the rules — half turns only, no mirroring, no
   overlaps, everything placed once. Paste it into Claude, or anything else.
2. **Paste the answer back.** It comes as `{"sheets": [{"sheet": "690x2500mm",
   "pieces": [{"id": "3", "orientation": 0, "x": 0, "y": 0}]}]}`, where x and y
   put the bottom-left corner of the piece's bounding box on the sheet.

Nothing pasted is taken on trust. It is checked against the same rules before it
is drawn — inside the sheet, no overlaps (by separating axis, not by eye), every
piece placed exactly once, orientation 0 or 180 — and what it costs is put next
to what the nester managed. A plan that breaks a rule is still drawn with the
breakages listed, since seeing where it went wrong is the useful part. The
built-in **Cut plan** tab is untouched by any of this, and nothing pasted is ever
written to your measurements.

The pasted plan survives a refresh. It is kept in this browser under two keys:
`roof.pastedPlan` is the plan that has been checked and drawn, and
`roof.pastedDraft` is whatever is in the box right now, saved on every
keystroke — so closing the tab part-way through a paste loses nothing, while
half-typed JSON is still not treated as a submitted plan. **Clear** empties
both. It is per-browser, so it does not follow you to another machine; the
`cuts.json` file is still the only durable record of the measurements.

## Reading the cut plan

Every sheet is drawn to **one scale**, so a 5 m sheet is twice the length of a
2.5 m one on the page and the sizes can be compared by eye — fitting each sheet
to the page separately made them all the same size, which is the opposite of what
the view is for. Each sheet is outlined, so the offcut is the space between the
pieces and that outline. The caption gives the shop's code, the size in cm, and
how much of it is used.

**Materials sit under the plan they belong to**, not on a tab of their own — the
sheets to buy and the drawing of what goes on them are one sheet of paper. So
the cut plan has its own bill, and a plan a model came back with has a different
one underneath it, which is how the two are compared.

## Printing

**Print this tab**, at the right of the tab bar, prints what you are looking at
and nothing else. The panels you are not on stay hidden, and so does everything
you would only ever click: the sidebar, the tabs, the measurement boxes, the
search controls and its list of plans, the prompt and the paste box. What is left
is the drawings and the materials — a cut plan and its bill on one sheet, the
model's plan and its bill on another.

## How the nesting works

16 mm multiwall has flutes running the length of the sheet, and they must run
down the slope so condensation drains. A piece can therefore be placed as-is or
turned a **half turn** (marked ↻ on the cut plan) — never a quarter turn.
Mirroring is also excluded: it keeps the flutes vertical but turns the
UV-protected face inward.

That leaves little room to manoeuvre, so the work happens in two stages:

1. **Merge** — every piece starts as a block of its own. The two blocks that
   waste least together are merged, over and over, until no merge saves
   anything. Because a merged block can merge again, a trapezoid and its
   half-turned twin can then take a triangle into the diagonal gap they leave,
   and a fourth piece after that. A merge too big for any sheet is never
   offered — it would strand every piece in it at once.
2. **Pack** — the resulting blocks are rectangles, so they shelf-pack: first fit
   into rows across the sheet width. Shelf packing is sensitive to the order
   blocks arrive in, so each plan is tried by height, by width and by area, and
   the cheapest kept. Each catalogue size is tried on its own, plus a mixed plan
   that picks the best-value size one sheet at a time.

### The Optimise button

The two stages above run on every keystroke, so they have to be quick, and they
pay for it twice: a merge only ever pairs two pieces, and a shelf wastes the
whole gap above its shortest block. **Optimise**, on the cut plan, runs a slower
nester that does neither.

It drops the merging and places the pieces themselves, bottom-left-fill: each
one goes into the lowest resting place that clears everything already down,
which is the notch the cut before it left. Every piece is convex, so the
horizontal extent at any height is one interval, two pieces at a fixed vertical
offset foul each other over exactly one interval of horizontal offsets, and the
leftmost lawful position is a sweep over those rather than a search. Nothing is
sampled and nothing is approximate.

The order the pieces arrive in still decides everything, so that is searched: a
swap or a half-turn at a time, keeping whatever comes out cheaper. On the roof
in `cuts.json` it finds **7 sheets at £652.06** where the quick nester finds 9 at
£738.36 — £86 and 10 percentage points of yield.

It takes about a minute, one round at a time between paints, and it shows the
running cost as it goes. The one button does all of it: **Optimise** starts it,
**Stop** while it runs, **Optimise more** once it has finished — which starts
again from a different random path and adds what it finds to the list rather
than replacing it. **Clear results** throws the lot away and starts over.

Stopping early is safe: every round is a complete plan, so what is on the screen
is always one you could order. Editing any measurement clears everything, because
it is no longer about your roof.

#### The ten on offer

Every plan the search tries is kept, not only the ones that beat the best, and
the ten cheapest distinct ones are listed under the buttons — sheets, price,
what it saves against the quick nester, and the sheets it asks you to buy. Two
plans of the same price that want different sheets are different answers, so the
sheet mix is part of what makes one distinct. Click any row to draw it; the cut
plan and the order table follow.

The search keeps the recipe rather than the plan — the order the pieces went
down and which were turned over — and packs it again when you click. Ten plans
cost nothing to hold.

#### Trying it with some slack

The box to the left of the button is how much to take off every piece before
searching: 0 by default, so **Optimise** searches the roof as measured. Put a
number in it and the same search runs on pieces scaled so each one's bounding
box is that many cm narrower and that many cm shorter. It answers one question:
is the cutting tolerance worth a sheet? On `cuts.json`, 2 cm is worth about £120
— which is worth knowing before you cut anything to the millimetre.

The pieces on a trial plan are **labelled with their own lengths**, not the ones
off the tape — a piece drawn 2 cm narrower reads 68 where you measured 70, so
what is on the drawing is always what is on the shape.

Those plans join the same list under a red **−2 cm** tag, and they are capped at
half the rows: a smaller roof is always cheaper, so left to sort on price alone
they would take every line and the plans you could actually buy would vanish.
Pick one and the page says plainly that its price is not one you can order.

The scale is not a true inward offset — shrinking the bounding box moves the
angles by a fraction of a degree on a piece two metres long. That is fine for
the question it answers and wrong for cutting from.

**The floor is £535.30** — the pieces' own area at £20.20/m². No arrangement can
beat it and none reaches it; it is there to say how much is left, which after
Optimise is 22%.

**Mirroring stays off, and this is settled.** A mirror would keep the flutes
running the right way and would improve the yield, but Axiome carries UV
protection on the outer surface only — confirmed with Clear Amber on 2026-08-28,
and stated on the [product page](https://clearambershop.com/products/axiome-clear-16mm-multiwall-polycarbonate-roofing-sheet).
A mirrored piece goes on with the unprotected face to the sky and yellows. Do not
re-enable it to chase yield.

## Layout

- `index.html`, `style.css` — page and styling
- `serve.mjs` — the dev server; serves the site and saves `cuts.json`
- `data/cuts.json` — your measurements; nothing but you writes to this
- `data/sheets.json` — the priced sheet catalogue and the kerf/margin settings
- `data/example-cuts.json` — a worked 28-piece hipped roof, 69 cm panels
- `src/geometry.js` — edge lists to polygons, areas, half turns
- `src/nest.js` — pairing and shelf packing, quick enough for every keystroke
- `src/nest-blf.js` — the slow nester behind Optimise: bottom-left-fill, searched
- `src/roof.js` — the pieces turned onto their eaves for the view from above
- `src/aiplan.js` — the prompt to take away, and the checking of what comes back
- `src/render.js` — SVG for pieces, cut plans, and the order table
- `src/main.js` — loading, watching the files for changes, and the four tabs

## Tests

```bash
node --test 'test/*.test.mjs'
```

The trapezoid solver and the packing bounds are where a silent sign error would
give plausible-looking wrong shapes, so those are what the tests cover.
