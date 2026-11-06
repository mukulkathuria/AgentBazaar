# Launch kit

Drafts for announcing AgentBazaar. Nothing in this folder is posted by any tool or workflow: a maintainer
reads, edits and posts each one by hand.

**Rule: launch only when every box in [launch-checklist.md](launch-checklist.md) is ticked.** If a check
fails, fix it or wait. Do not launch on a promise.

Before posting any draft:

- Fill every `<!-- METRIC:name -->TBD<!-- /METRIC -->` marker from a recorded run, or delete the sentence
  that contains it. Never post a `TBD`, and never replace one with a guess.
- Re-copy any code excerpt from the files at the release tag; the code keeps moving.
- Check the community's current rules (self-promotion limits, required flair, posting days).
- Keep the status lines honest: lite release candidate, growth and scale not finished, Razorpay not yet
  verified against its live sandbox, YouPI-PG experimental, no real money before an independent
  penetration test.

| File | Where | Notes |
| --- | --- | --- |
| [launch-checklist.md](launch-checklist.md) | Internal | The gate. Every box must be verifiable |
| [registry-and-awesome-lists.md](registry-and-awesome-lists.md) | MCP registry, awesome lists, directories | Only after the public demo URL works |
| [show-hn.md](show-hn.md) | Hacker News | Title options, post body, first comment |
| [reddit-selfhosted.md](reddit-selfhosted.md) | r/selfhosted | One VPS, Compose, Caddy, no telemetry |
| [reddit-opensource.md](reddit-opensource.md) | r/opensource | Licence, governance, ways to contribute |
| [reddit-developersindia.md](reddit-developersindia.md) | r/developersIndia | GST, UPI, COD, DPDP, Hindi, paise |
| [product-hunt.md](product-hunt.md) | Product Hunt | Tagline, description, maker comment, gallery |
| [devto-article.md](devto-article.md) | dev.to | Technical article on safe agent negotiation |
| [linkedin.md](linkedin.md) | LinkedIn | Short post from Mukul Kathuria |

Suggested order once the checklist is green: MCP registry, then Show HN, then the Reddit posts spread over
several days, then Product Hunt, the dev.to article and LinkedIn. Someone should be available to answer
questions for 48 hours after each post.
