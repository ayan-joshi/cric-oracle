# CricOracle — Future Product Vision

## The Killer Insight

Cricket fans CONSTANTLY argue about rules in WhatsApp groups.
"Was that LBW out?" "Can a fielder do that?" "Is Mankad legal?"

Nobody has a quick, trustworthy, official answer. Google gives forum opinions.
CricOracle gives the ACTUAL LAW with the clause number.

**That's the product: The Official Cricket Argument Settler.**

---

## IPL Opportunity (launches 28 March 2026)

IPL is the most watched T20 league in the world. Every match generates:
- Controversial decisions fans argue about
- Unique T20/IPL-specific rules casual fans don't know
- Massive social media traffic around every game

**Positioning: "The IPL Argument Settler — powered by official cricket laws"**

### IPL-specific rules most fans don't know (perfect quiz/content fodder):
- Free hit only applies after front-foot no-balls (not wides or other no-balls)
- Impact Player rule — a substitute can bat or bowl mid-match (IPL-exclusive)
- DRS — each team gets 1 unsuccessful review per innings in IPL
- Power play fielding restrictions (0-6 overs: max 2 fielders outside ring)
- Strategic timeout — 2 timeouts per innings, 6-9 overs and 13-16 overs window
- Super Over tiebreaker rules
- Mankad run-out — fully legal, controversial every time it happens in IPL

### IPL Controversy Content (index and answer these):
- Was Mankad legal when Ashwin ran out Buttler? (2019 — went viral globally)
- Impact Player — can an Impact Player bowl all 4 overs?
- Can a batter be timed out in IPL? (happened in ODI World Cup 2023)
- What happens if it rains during Super Over?
- Boundary catch — when is it out vs not out if fielder steps on rope?

### IPL Season Content Calendar:
- Pre-match: "Rules you need to know before tonight's [TeamA vs TeamB]"
- Post-match: "Was that DRS review correct? Here's what the law says"
- After controversies: instant verdict card shareable on WhatsApp/Twitter

---

## Product Repositioning

| Before | After |
|--------|-------|
| "A RAG that answers cricket law questions" | "Settle any IPL argument in seconds — backed by official laws" |
| Developer learning project | Tool IPL fans share during live matches |
| Text answer | Shareable verdict card with law citation |

---

## 5 Features That Make It Shareable

### Feature 1: "Settle the Argument" Mode (CORE)
Instead of a bland search box, frame it as argument settling.

```
UI shows:
"Describe the cricket situation"

CricOracle gives:
- Official verdict (OUT / NOT OUT / DEPENDS)
- Exact law + clause cited
- Plain English explanation
- "Share this verdict" button
```

### Feature 2: Shareable Verdict Cards
Every answer generates a screenshot-ready card:

```
┌─────────────────────────────────┐
│  🏏 CricOracle Verdict          │
│                                 │
│  "Can a fielder catch the ball  │
│   after it hits the boundary    │
│   rope?"                        │
│                                 │
│  ❌ NOT OUT — It's a BOUNDARY   │
│                                 │
│  Law 19.3: Once the ball touches│
│  the boundary rope, it is dead  │
│  and four runs are awarded...   │
│                                 │
│  cricoracle.app                 │
└─────────────────────────────────┘
```

WhatsApp-shareable. Twitter-shareable. The law citation makes it feel authoritative.

### Feature 3: Daily IPL Law Quiz
Auto-generated, timed to match schedule. New quiz on every match day.

```
"IPL Match Day Quiz — RCB vs MI tonight"
Q: How many Impact Player substitutions are allowed per match?
A: [1] [2] [3] [4]

Score: 4/5 — "Better than the on-field umpire!"
Share your score → WhatsApp button
```

Drives daily return visits during IPL season (74 matches over ~2 months).

### Feature 4: "Was It Out?" Scenario Analyzer
User describes a real match situation:

```
"Kohli hit the ball, it deflected off the helmet on the ground,
 fielder caught it. Is it out?"

CricOracle:
→ Finds Law 28 (Fielder's helmet on ground)
→ Finds Law 32 (Caught)
→ Verdict: NOT OUT — Law 28.3 states...
```

Perfect for IPL controversies. Goes viral every time there's a disputed decision on TV.

### Feature 5: WhatsApp Share Integration
Every verdict has a pre-filled WhatsApp share message:

```
"🏏 Asked CricOracle about [question]
 Official verdict: [answer]
 Law [X], Clause [Y]
 Check it yourself: cricoracle.app"
```

This is the growth engine. One share brings 20 new users from the group.

---

## Data Roadmap

| Phase | Source | Value |
|-------|--------|-------|
| V1 (Saturday) | laws.mcc.org.uk | 42 MCC laws — the foundation |
| V2 (before 28 Mar) | BCCI/IPL Playing Conditions + ICC T20 rules | IPL-specific rules — Impact Player, DRS, timeouts |
| V3 (during IPL) | Past IPL controversies — curated manually | Mankad, boundary catches, DRS blunders |
| V4 (later) | ICC ODI/Test Playing Conditions | Expand beyond IPL |

---

## Why It's Entrepreneur-Worthy

- **Target users:** 500M+ cricket fans, IPL alone gets 600M+ viewers per season
- **Pain point:** Every IPL match creates rule arguments in every group chat
- **Timing:** IPL starts 28 March — 2-week window to launch something topical
- **Distribution:** WhatsApp groups = free viral growth, especially during live matches
- **Monetisation:** Free now → fantasy app sponsorships, Dream11/My11Circle ads
- **Moat:** Most accurate (grounded in actual laws) + most shareable UI

---

## Build Order (after Saturday's core RAG is done)

1. Reframe UI copy → "Settle the IPL argument" language
2. Index IPL Playing Conditions + BCCI rules (Impact Player rule especially)
3. Build verdict card component (CSS-only, screenshot-ready, mobile-first)
4. Add WhatsApp share button with pre-filled message
5. Add daily IPL match-day quiz
6. Manually add 10-15 famous IPL controversies as curated content
7. Custom domain — cricoracle.app
