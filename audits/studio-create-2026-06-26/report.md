# SnapBOS Studio Create Audit - 2026-06-26

## Scope

Audited the live SnapBOS Studio Create flow in the user's signed-in Chrome session:

`https://snapbos.com/portal/studio?create=1&tab=identity&projectId=b6380912-2c46-449f-98c5-3b52ce764fa3`

Also inspected the live server repo at `/root/projects/whatsipa`, checked frontend/backend/gpu-worker alignment, looked at the target project row, reviewed git state, and ran builds.

## Evidence

Fresh screenshots and DOM summaries are saved here:

- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/01-identity-current.png`
- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/02-looks.png`
- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/03-voice.png`
- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/04-story.png`
- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/05-frames.png`
- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/06-video.png`
- `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/07-export.png`
- Console warnings/errors: `/Users/ba2ki-goldvest/Desktop/Gaia-Healers-App/audits/studio-create-2026-06-26/chrome/console-warnings-errors.json`

No browser console warnings/errors were captured during the tab pass.

## Step Health

1. Identity: needs work. The visible page showed the photo booth even though this project already has `persona_asset_id`, `storyboard_id`, and `generated_video_id` in the DB. The older subflow also has multiple states: upload/selfie, create identity, review descriptor/profession, generate 6 identities, pick favorite. That is too much for one top-level step.

2. Looks: mixed. The profession/DNA prefill is useful, but it repeats concepts already introduced in Identity. It says "Generate Professional Look Pack" even when the project metadata already references a ready professional look asset. The actual `studio_projects.look_id` is null, so the gate does not trust that metadata.

3. Voice: mostly healthy. The screen is short and understandable. However, it is blocked downstream by the look requirement even though voice itself is already set in the project row.

4. Story: broken state. The screen says "One step missing" because `look_id` is null, but the same project has a real `storyboard_id`. Users can see a locked Story after already having story/video output.

5. Frames: inconsistent but usable. It opens because `storyboard_id` exists and shows 4 approved scenes, but the look selector box is visually empty and still says "Locked look - matches your storyboard." This is a confusing partial state.

6. Video: usable. Recipes and cost estimates are clear. The step opens because storyboard exists. The bottom action says Continue to Export, but the real route key is `publish`.

7. Export: route mismatch. Direct `tab=export` renders Identity because the app only recognizes `tab=publish` internally while labeling it "Export" in the UI. This creates a bookmark/deep-link bug and makes the 7-step naming less reliable.

## Main Findings

### 1. The project state contract is inconsistent

Server DB for project `b6380912-2c46-449f-98c5-3b52ce764fa3`:

- `persona_asset_id`: `fe7fcf1e-dcd4-49dc-8f00-fb04e2cf37d6`
- `look_id`: `null`
- `voice_profile_id`: `4a4ec810-4ca0-4991-b8db-34284c3c08df`
- `storyboard_id`: `43174620-5e59-46c7-9d99-33b258e1493d`
- `generated_video_id`: `400f24f6-41be-48e1-856e-e85702b9ce6f`
- `creative_center`: `human`
- `media_inputs`: `["avatar", "looks", "voice", "sound_music"]`

But project metadata contains a professional look context:

- `metadata.draft.blueprint.context.look.assetId`: `ed283264-8a53-482e-b334-1d6b0c441c4a`

That look asset exists and is ready:

- `type`: `professional_look`
- `status`: `ready`
- `role`: `luxury real estate broker`
- `variation`: `stylized_campaign`

Impact: Story gates from `project.lookId`, Frames/Video gate from `project.storyboardId`, and the storyboard metadata references a look that the main project row does not. This lets users reach impossible combinations: Story locked, Frames open, Video open, Export internally present.

Relevant server/frontend code:

- `/root/projects/whatsipa/frontend/src/features/studio/StudioShell.tsx:108` defines `publish` with label `Export`.
- `/root/projects/whatsipa/frontend/src/features/studio/StudioShell.tsx:653` snaps invalid/hidden tabs to the first visible tab.
- `/root/projects/whatsipa/frontend/src/features/studio/StudioShell.tsx:761` locks Story when `project.lookId` is missing.
- `/root/projects/whatsipa/frontend/src/features/studio/StudioShell.tsx:767` opens Frames when `storyboardId` exists.
- `/root/projects/whatsipa/frontend/src/features/studio/StudioShell.tsx:769` opens Publish/Export when `generatedVideoId` exists.

### 2. Identity is doing too many jobs

The top-level "Identity" step contains a nested 3-step wizard and hidden legacy states:

- Add photo or take selfie
- Create Studio Identity
- Ask AI to identify/describe user
- Ask profession
- Prefill from DNA
- Create 6 identities
- Choose favorite
- Descriptor panel / recompute / manual edit
- Brand character fallback

Relevant code:

- `/root/projects/whatsipa/frontend/src/features/personas/PersonaStudioPage.tsx:114` identity-pack state starts.
- `/root/projects/whatsipa/frontend/src/features/personas/PersonaStudioPage.tsx:124` role/profession confirmation state starts.
- `/root/projects/whatsipa/frontend/src/features/personas/PersonaStudioPage.tsx:128` identity descriptor state starts.
- `/root/projects/whatsipa/frontend/src/features/personas/PersonaStudioPage.tsx:960` photo booth UI.
- `/root/projects/whatsipa/frontend/src/features/personas/PersonaStudioPage.tsx:1032` profession/descriptor UI.
- `/root/projects/whatsipa/frontend/src/features/personas/PersonaStudioPage.tsx:1111` identity pack gallery.

Impact: the user thinks the whole website has 7 steps, but Step 1 alone contains its own product. That makes the flow feel long even before the ad has a story or video.

### 3. Export label and route key disagree

The code uses `publish` as the tab key and `Export` as the label. The live URL tested with `tab=export` fell back to Identity.

Impact: users and support will naturally say/export-link `tab=export`, while the system requires `tab=publish`. This is small but sharp.

Fix direction: support both keys:

- Accept `tab=export` as an alias for `publish`.
- Prefer writing `tab=publish` or rename the key to `export` everywhere in a migration.
- Update old redirects that use `/portal/studio?tab=publish` if the product language is now "Export."

### 4. Watermark is mostly aligned, but not fully productized

Current uncommitted server changes wire the logo watermark from workspace brand assets into render payload:

- `/root/projects/whatsipa/backend/src/services/ads/render-queue-service.ts:631`
- `/root/projects/whatsipa/backend/src/services/ads/render-providers/render-provider.types.ts`
- `/root/projects/whatsipa/gpu-workers/ai-ads-render/app/main.py:859`

Frontend setup is in:

- `/root/projects/whatsipa/frontend/src/features/personas/IdentityPackGallery.tsx`
- `/root/projects/whatsipa/frontend/src/features/personas/WatermarkStudio.tsx`
- `/root/projects/whatsipa/frontend/src/features/personas/usePersonas.ts:468`

Good: frontend upload/settings, backend payload injection, and GPU worker composer fields are now conceptually aligned.

Risk: setup-only WatermarkStudio persists position and opacity, but not the "Show watermark" enabled/disabled toggle or logo size. Backend only forwards URL, position, opacity. If users turn off watermark or resize it in photo mode, video may still watermark with default size/enabled behavior.

### 5. Visual hierarchy is polished but too stacked

The dark visual system is consistent. The problem is density and competing navigation:

- left app navigation
- create flyout
- breadcrumb
- top 7-step rail
- "BOS Creative Wizard" bar
- identity mini stepper
- central card
- sticky bottom actions
- Ask BOS overlay

Impact: the page feels like several shells at once. Users need fewer persistent layers and more direct "what do I do now?"

### 6. Accessibility risks from screenshots and DOM

Likely risks:

- Low contrast in secondary helper text and disabled controls on dark backgrounds.
- The guided progress rail is non-clickable but looks like pill buttons; users may try to interact.
- Locked future steps rely on title tooltips and icons; not enough visible explanation until the user reaches the locked screen.
- Sticky bottom footer can cover lower content, especially with Ask BOS overlay.
- Nested details/hidden advanced paths may be missed by keyboard and screen-reader users if focus order is not tested.

Verification gap: full keyboard and screen-reader traversal was not performed. This audit is based on DOM snapshots, visible screenshots, route behavior, and code inspection.

## Recommended Simplified Create Flow

Replace the current 7 visible steps with a shorter 4-stage guided flow, while keeping expert tabs available behind "Expert controls."

### Stage 1: Identity

Goal: produce one approved identity, not six separate decisions.

Screen structure:

- Left: upload/selfie card.
- Right: live identity preview/status.
- One combined "AI read" panel: descriptor + profession + DNA chips.
- CTA: "Create identity options".
- Result: show 6 identities in a compact chooser.
- User picks one. Save both `persona_asset_id` and selected identity/look context in one transaction.

Remove from first-pass:

- body-mode choice unless needed for a failed result.
- brand character fallback as a primary card. Keep it as "No photo? Create a character" secondary.
- separate descriptor panel below the fold.

### Stage 2: Look + Voice

Combine current Looks and Voice.

Why: after Identity, the user is choosing how the person appears and sounds. These are casting decisions, not separate journey chapters.

Screen structure:

- "Role and style" row with profession prefilled from DNA, editable.
- "Look pack" result cards with one selected look.
- "Voice" selector in the same page, defaulted and editable.
- CTA: "Continue to Story."

This reduces one top-level step immediately.

### Stage 3: Story + Frames

Combine Story and Frames into one "Script and scenes" stage.

Why: frames are visual proof of the story. The user does not need to think of this as two separate tasks.

Screen structure:

- Brief/hook/CTA at top.
- Timeline rows: voiceover, visual prompt, generated frame, approve/regenerate.
- One selected look shown as context.
- CTA: "Create video."

### Stage 4: Video + Export

Combine recipe, render, final asset, captions, UTM/export.

Screen structure:

- Recipe selector with credit estimate.
- Preview/render status.
- Once video exists, reveal export pack: download, caption, UTM, posting options.
- Brand Logo watermark button appears here and in Identity, but as a global brand setting.

## State Contract Plan

Create one canonical stage-readiness object from the backend, and let the frontend render from that instead of mixing fields.

Suggested API response:

```ts
type StudioCreateReadiness = {
  identity: { ready: boolean; assetId?: string; source: 'project' | 'metadata' | 'library' | null };
  look: { ready: boolean; assetId?: string; source: 'project' | 'storyboard_metadata' | null };
  voice: { ready: boolean; profileId?: string | null };
  story: { ready: boolean; storyboardId?: string | null };
  video: { ready: boolean; videoId?: string | null };
  export: { ready: boolean; videoId?: string | null };
  repairActions: Array<{ key: string; label: string; payload: unknown }>;
};
```

Immediate repair rules:

- If `look_id` is null but latest storyboard/blueprint references a ready `professional_look`, surface "Restore selected look" and optionally auto-patch `look_id`.
- If `generated_video_id` exists, never show earlier steps as hard-blocking unless the user explicitly chooses to rework them.
- If `tab=export`, alias to `publish`.
- If `tab=story` is locked but `storyboard_id` exists, treat story as ready and show the storyboard rather than "One step missing."

## Frontend Redesign Plan

1. Add a Studio stage adapter.
   - Centralize TABS, labels, aliases, gate rules, and stage readiness in one module.
   - Make `publish/export` alias explicit.

2. Split PersonaStudioPage into smaller guided components.
   - `IdentityPhotoStep`
   - `IdentityReviewStep`
   - `IdentityOptionsGrid`
   - `IdentityStateRepairBanner`
   - Keep the existing old modes behind expert/backward-compatible props.

3. Merge Looks and Voice in guided mode.
   - Keep the current standalone `ProfessionalLooksBuilder` and `VoiceTab` for expert mode.
   - Create guided `CastingStep` that composes them.

4. Merge Story and Frames in guided mode.
   - Keep `StoryBuilder` and `FramesTab` internally.
   - Create guided `ScriptScenesStep` that shows storyboard and frames as one timeline.

5. Merge Video and Export in guided mode.
   - Keep `VideoTab` and `PublishTab` internally.
   - Create guided `ProduceExportStep`.

6. Simplify persistent UI.
   - Keep breadcrumb small.
   - Replace the 7-step rail with 4 larger stages.
   - Remove the duplicate "BOS Creative Wizard" strip or collapse it into the stage header.
   - Keep one sticky action area only.
   - Move Ask BOS so it does not overlap sticky CTA.

7. Add recovery states.
   - "We found your generated video. Continue to Export."
   - "We found a look used by your storyboard. Restore it."
   - "Your identity is ready. Continue to Casting."

## Backend Plan

1. Add or extend `/api/v1/studio/:id/status` to return canonical create readiness, not just booleans.
2. Add a repair endpoint or PATCH helper to set `look_id` from the storyboard/blueprint look asset when safe.
3. Update project patch side effects so selecting/generating a look and generating a storyboard cannot drift.
4. Add a migration/backfill script for projects where metadata references a valid look but `look_id` is null.
5. Persist watermark enabled and size if those are intended user settings for video.

## Git And Build Check

Remote repo:

- Path: `/root/projects/whatsipa`
- Branch: `phase22/studio-pricing-deploy`
- Tracking: `origin/phase22/studio-pricing-deploy`

Dirty tracked files:

- `backend/src/services/ads/render-providers/render-provider.types.ts`
- `backend/src/services/ads/render-queue-service.ts`
- `frontend/public/build-id.txt`
- `frontend/src/features/personas/IdentityPackGallery.tsx`
- `frontend/src/features/personas/WatermarkStudio.tsx`
- `gpu-workers/ai-ads-render/app/main.py`

Untracked:

- `.agents/`
- `.scratch/`
- `CLAUDE.md`
- `docs/agents/`
- `skills-lock.json`

Recent commits:

- `8de2de5 chore(deploy): bump build-id`
- `f12602e feat(studio): logo watermark - upload+cleanup, live overlay, download`
- `ea49712 fix(studio): edits change only what's asked; no text baked into images`
- `ecbde54 feat(studio): creative variety per identity + real background-removal edit`
- `ce9f6de feat(studio): per-photo edit + non-destructive Back/Forward in Identity`

Checks run:

- `git diff --check`: passed
- `cd backend && npm run build`: passed
- `cd frontend && npm run build`: passed, with existing Vite warnings about mixed dynamic/static import and large chunks

## Priority Fix List

P0:

- Fix `tab=export` alias to `publish`.
- Fix readiness so Story cannot be locked when `storyboard_id` exists.
- Repair `look_id` drift for this project and similar projects.

P1:

- Collapse guided Create from 7 steps to 4 stages.
- Split the Identity mega-component into focused substeps.
- Add state-repair banners instead of silently falling back to Identity.

P2:

- Persist watermark enabled/size if those controls are meant to apply to videos.
- Improve contrast and focus behavior in the progress rail, sticky footer, and disabled controls.
- Reduce duplicate headers and persistent bars.

## Bottom Line

The latest Studio work compiles and the watermark pipeline is broadly wired through frontend, backend, and GPU worker. The biggest issue is not broken rendering code; it is state drift and UX layering. The Create flow needs one canonical readiness contract and a shorter guided experience. Once `look_id`, `storyboard_id`, `generated_video_id`, and the route tab aliases all tell the same story, the redesign can become much cleaner without throwing away the current design system.
