---
status: DRAFT for the author to edit; not published
suggested_title: "I measured AI coding agents on Deno and Transformers. My first answer was wrong."
---

# I measured AI coding agents on Deno and Transformers. My first answer was wrong.

Every engineering leader is being asked the same question right now: *are our AI coding agents actually paying off?* Most answers I see are vendor claims or small benchmarks on toy tasks. I wanted to know what the evidence looks like on real production history, so I built a tool to measure it and ran it on two large open-source projects.

My first result looked like a clean win for agents. It was mostly an artefact. This post is about how I caught it, because the mistake is one any team doing this measurement is likely to make.

## The setup

The tool is [SeamLens](https://github.com/vikasny30/seamlens). Its `impact` command reads a repository's git history, splits commits into **agent-assisted** and **other**, and compares them on a few outcomes. It runs locally and uses no LLM, so the same history always gives the same numbers.

Three design choices matter:

1. **Attribution comes from commit metadata.** A commit counts as agent-assisted only if it carries a trailer such as `Co-Authored-By: Claude` or a "Generated with …" line. A commit that merely mentions an agent does not count. This is a *lower bound*: agent work without a trailer lands in "other", which pushes results toward "no difference".
2. **Every rate carries a 95% confidence interval**, and the tool refuses to call one side better unless each group has at least 30 commits and the intervals do not overlap. Below that it says "insufficient data". I would rather print a non-answer than a confident wrong one.
3. **Recent commits are excluded from outcome metrics**, because a commit from last week has not had time to be reverted or fixed yet.

## The first answer

On Deno (3,127 commits since September 2025; 427 carried an agent trailer) and Hugging Face Transformers (3,908 commits; 236 carried one), agent-assisted commits were more likely to include test changes alongside source changes:

- Deno: 77.5% vs 70.8%
- Transformers: 59.4% vs 44.6%

The intervals did not overlap in either repository. A tool, or a slide, would stop here: *agents write more tests.*

## Why that was wrong

Agent commits were also **bigger**: median 113 vs 87 changed lines in Deno, 45 vs 36 in Transformers. And size drives almost everything. A 5-line change rarely touches a test; a 150-line change usually does. If agents write bigger commits, they will look more diligent about tests even if, line for line, they are not.

So I re-ran the comparison inside four commit-size bands. In Deno, **no band shows a detectable difference**. In Transformers only the smallest band does (27% vs 9% for commits under 20 lines); the other three overlap. The pooled gap was largely commit size in disguise.

I do not conclude that agents add nothing. In nearly every band the agent point estimate is higher, but each band has only tens to a couple of hundred agent commits, which is too few to confirm a modest effect. The honest statement is: *the data cannot distinguish a small real effect from none, and the headline number was misleading.*

## What the other metrics showed

Reverts are rare in both repositories (about 0.5%) with no detectable difference. Two other proxies, "a fix touches the same files within 7 days" and "the same files are touched again within 14 days", were so high for both groups (47% to 65%, and 77% to 86%) that they could not separate anything. In a busy repository almost every file is touched again within days. A metric that saturates tells you nothing, and I now say so in the tool's output.

## What I changed in the tool

`seamlens impact` now re-checks every overall difference inside size bands and prints a *size-adjusted reading* next to the pooled one. If a gap disappears when you control for size, the report says so. There are tests for exactly this trap: a synthetic history where size is the only driver must be flagged, and a synthetic history with a real effect in every band must be reported as holding.

## What I would tell an engineering leader

1. **Ask for the denominator and the interval.** "Agents improved quality" without both is not a measurement.
2. **Stratify before you celebrate.** Agent and human work differ in size, files and risk. Compare like with like.
3. **Distrust saturated proxies.** If almost everything scores high, the metric is not measuring what you hoped.
4. **Measure the unflattering outcomes too:** reverts and rework, not only throughput.
5. **Do not rank people.** Cohort comparisons are about the process. Pseudonymise by default.

## Limits

Two repositories are not a population. Attribution depends on contributors adding trailers. Commit size is not value. I did not measure defects, only proxies. The scripts and exact commits are in the repository so you can check or refute this.

If you run it on your own history and the answer surprises you, I would like to hear about it.

*Reproduce: see `docs/results/open-source-agent-impact.md`.*
