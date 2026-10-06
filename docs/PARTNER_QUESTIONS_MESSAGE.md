# Message to the Gaia Practitioners developer (draft — not sent)

**Subject:** Gaia Healers × Gaia Practitioners: 11 questions on recommendations, flags and client-facing data

Hi [name],

We're designing how Gaia Healers members see recommendations from their
practitioner. We'd like your platform to stay the place where Bio-Well
analysis happens, so that we don't duplicate it. A practitioner would review
and approve suggestions inside our Practice screen, and only approved,
client-safe items would reach the member.

Before we build on your data, we need precise answers to these questions.
Tool names refer to your MCP (`tools/list` on staging, 6 Oct 2026).

**AI-generated recommendations (`get_customer_recommendations`)**

1. Is `recommendations[].recommendations` generated from the scan identified
   by `scan_id`? Exactly which inputs go to the model:
   - labelled scan values (stress, energy, chakras, organs, meridians,
     systems);
   - customer sex and DOB;
   - `list_services` / `list_products`;
   - earlier scans?
2. Which model and provider generates it, and in which region? Is a data
   processing agreement or BAA in place for that processing? What is the
   provider's data retention?
3. What triggers generation: each scan sync, or a practitioner action? Is a
   record ever regenerated or overwritten under the same `id`, or is a new
   record always created?
4. Does the practitioner see a recommendation in your UI before the client
   can? Can they edit, approve or reject it? If so, is that state stored, and
   could the MCP expose it (e.g. `status`, `reviewed_by`, `reviewed_at`,
   `edited_text`)?
5. What is the JSON schema of the `recommendations` field?
   - Which item types (practice / service / product / follow-up)?
   - Do items reference `list_services` or `list_products` by `id`?
6. Are `script` and `video_url` delivered to the client today (email, app,
   portal)? Are they intended as client-facing content?

**Deterministic data**

7. Are `attributes` and `systems` on `list_services` / `list_products`
   entered by the practitioner, or set by the platform? Who curates the
   "platform products" returned by `list_products`?
8. Are the flag rules from the tool descriptions Bio-Well's published
   guidance or your platform's own? The rules are:
   - disbalance ≥ 20%;
   - elevated 20–40%, high ≥ 40%;
   - direction ±5 points;
   - 3 consecutive worsening sessions.

   If they are Bio-Well's, which document and version?

**Integration**

9. Would you add a member-scoped tool returning **approved items only**, e.g.
   `get_my_path → [{ id, title, member_safe_reason, type, ref, priority,
   practitioner_note, approved_by, approved_at, revoked_at, version }]`?
   Or a write scope so Gaia can store practitioner approvals against your
   recommendation ids? Or are you comfortable with Gaia being the system of
   record for approvals made in our Practice screen?
10. `get_dashboard_summary` timed out on staging with "Bio-Well did not
    answer within 30s". Do practice-level tools call Bio-Well live? When will
    the production MCP match staging?
11. When your platform returns flags, trends, suggested services or
    AI-generated recommendations, which fields do you consider
    safe/intended for display directly to the client, and which are
    practitioner-only?

For context, we have already done the following on our side:
- Gaia's AI assistant no longer receives reading values, percentages,
  severities, scan ids or dates, or client personal details from your tools.
  It sees only the client's name and id, plus "area — flagged".
- We do not read your AI-generated recommendations at all until we have your
  answers.

Thanks,
Babak
Gaia Healers
