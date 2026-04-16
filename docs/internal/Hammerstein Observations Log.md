# Hammerstein Observations Log — GeneralStaff

Ray's first-person reflective log. Append-only. Tracks whether
the clever-lazy framework actually works in practice across the
GeneralStaff project and the products it manages.

Mirrors `catalogdna/docs/internal/Hammerstein Observations Log.md`
in convention. The same ground rules apply:

- **Append-only** — don't rewrite or edit previous entries
- **Log negatives aggressively** — counter-observations and
  negative data points are higher-value than positive ones;
  they're the tests that could falsify the model
- **Prose is fine** — no force-fitting into a schema
- **Selection bias is the enemy** — "the frame worked great"
  entries with no negative counterpart make the log worthless
- **Sign entries** — Ray writes first-person; Claude in
  interactive sessions can append with
  `— Claude (interactive session, YYYY-MM-DD)` to distinguish

**Hands-off for autonomous bot runs:** the bot writes to
`Hammerstein Observations - Claude.md` instead, per catalogdna's
convention.

---

*(No entries yet. Ray writes the first one when he has something
worth recording.)*

Ray - 4.15.2026 - one thing I want to note in contracdiction to the bot note is that I don't think the intial negative signals are a bad thing - across a couple projects I've noticed that intial negative signials exist in a brand new project and as the project matures, those tend to shift. more testing across projects will be needed

4.16.26 - Work PC session ~9-10 hours, all on one session with 1M context, probably the most single productive session across any of my projects, dogfooding was essential and seems to be a strong case study for the method itself given we completely shipped phase 1 and beyond in one day with barely any intervention from me. This should probably be the model going forward for me across projects once this is fully built out - amazing work today by claude, one thing he mentioned to me earlier: "about exponential productivity — is a really interesting data point. The
  framework predicts that the run-observe-codify-repeat loop compounds. This session is the strongest evidence yet: each round built on the last, the bot
  got faster as test infrastructure accumulated, and the features got more ambitious. catalogdna took 22 runs to reach this maturity; GeneralStaff hit it in
   one session because it inherited the patterns."