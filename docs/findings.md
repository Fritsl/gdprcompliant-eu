# The finding types

Generated from the registry by `scripts/findings-doc.ts`: `packages/findings/content/detectors.json`,
the binding tables, the remedy catalogue, the guides and the fixture estate. Every type the product
can raise has a detector, a remedy of a declared kind in every supported jurisdiction, a binding
that resolves in the corpus, a guide a non-specialist can follow, and a fixture that proves it
fires and one that proves it does not. A type missing any of these fails the build.

31 types. Jurisdictions: DE, DK.

## APP-01 · The app store listing declares data the privacy policy does not mention

- Area: Notice. Default severity: serious.
- Detector: `scanner/apps#declared_not_in_policy` (no scanner family: verified another way).
- Remedy in DE: `app-01-say-what-the-app-collects` v2 (generated_artefact, verified by artefact_published).
- Rests on in DE: GDPR Art. 13(1)(c) `GDPR:13:1:c`; GDPR Art. 5(1)(a) `GDPR:5:1:a`.
- Remedy in DK: `app-01-say-what-the-app-collects` v2 (generated_artefact, verified by artefact_published).
- Rests on in DK: GDPR Art. 13(1)(c) `GDPR:13:1:c`; GDPR Art. 5(1)(a) `GDPR:5:1:a`.
- Guide: `app-01` (da, de, en).
- Fixtures that must raise it: **none**.
- Fixtures that must not: **none**.

## CLK-01 · The site shows a different page to scanners than to visitors

- Area: Recipients. Default severity: serious.
- Detector: `scanner/checks/security#cloaking` (family `security`).
- Remedy in DE: `clk-01-same-site-for-everyone` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 5(1)(a) `GDPR:5:1:a`; GDPR Art. 5(2) `GDPR:5:2`.
- Remedy in DK: `clk-01-same-site-for-everyone` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 5(1)(a) `GDPR:5:1:a`; GDPR Art. 5(2) `GDPR:5:2`.
- Guide: `clk-01` (da, de, en).
- Fixtures that must raise it: cloaked-shop.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## CNS-01 · A tracker loads before the visitor has been asked

- Area: Consent. Default severity: serious.
- Detector: `scanner/passes/differ#before_interaction` (family `consent`).
- Remedy in DE: `cns-01-gate-before-interaction` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(1) `GDPR:7:1`.
- Remedy in DK: `cns-01-gate-before-interaction` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(1) `GDPR:7:1`.
- Guide: `cns-01` (da, de, en).
- Fixtures that must raise it: lazy-tracker, us-tag-manager.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, hosted-fonts.

## CNS-02 · Refusing cookies changes nothing: the trackers run anyway

- Area: Consent. Default severity: blocking.
- Detector: `scanner/passes/differ#refusal_ignored` (family `consent`).
- Remedy in DE: `cns-02-gate-tags` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 7(3) `GDPR:7:3`.
- Remedy in DK: `cns-02-gate-tags` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 7(3) `GDPR:7:3`.
- Guide: `cns-02` (da, de, en).
- Fixtures that must raise it: reject-not-honoured.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, insecure-forms, preticked-forms.

## CNS-03 · The banner offers no way to refuse

- Area: Consent. Default severity: serious.
- Detector: `scanner/consent/banner#no_refusal_path` (family `consent`).
- Remedy in DE: `cns-03-offer-a-refusal` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(3) `GDPR:7:3`.
- Remedy in DK: `cns-03-offer-a-refusal` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(3) `GDPR:7:3`.
- Guide: `cns-03` (da, de, en).
- Fixtures that must raise it: banner-accept-only.
- Fixtures that must not: banner-cookiebot-like, banner-direct-reject, banner-forgets, banner-german-switches, banner-in-iframe, banner-onetrust-like, banner-two-layer, banner-usercentrics-shadow, clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## CNS-04 · The site forgets what the visitor chose

- Area: Consent. Default severity: serious.
- Detector: `scanner/passes/pass-bc#choice_not_remembered` (family `consent`).
- Remedy in DE: `cns-04-remember-the-choice` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 7(1) `GDPR:7:1`.
- Remedy in DK: `cns-04-remember-the-choice` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 7(1) `GDPR:7:1`.
- Guide: `cns-04` (da, de, en).
- Fixtures that must raise it: banner-forgets.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## CNS-05 · Refusing takes more clicks than accepting

- Area: Consent. Default severity: serious.
- Detector: `scanner/passes/differ#no_reject_on_first_layer` (family `consent`).
- Remedy in DE: `cns-05-reject-on-the-first-layer` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 7(3) `GDPR:7:3`; GDPR Art. 4(11) `GDPR:4:11`; ePrivacy Art. 5(3) `ePrivacy:5:3`.
- Remedy in DK: `cns-05-reject-on-the-first-layer` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 7(3) `GDPR:7:3`; GDPR Art. 4(11) `GDPR:4:11`; ePrivacy Art. 5(3) `ePrivacy:5:3`.
- Guide: `cns-05` (da, de, en).
- Fixtures that must raise it: banner-two-layer.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## CNS-06 · The optional categories are switched on before the visitor chooses

- Area: Consent. Default severity: serious.
- Detector: `scanner/passes/differ#pre_ticked_toggles` (family `consent`).
- Remedy in DE: `cns-06-untick-the-toggles` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(2) `GDPR:7:2`; ePrivacy Art. 5(3) `ePrivacy:5:3`.
- Remedy in DK: `cns-06-untick-the-toggles` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(2) `GDPR:7:2`; ePrivacy Art. 5(3) `ePrivacy:5:3`.
- Guide: `cns-06` (da, de, en).
- Fixtures that must raise it: banner-two-layer.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## CNS-07 · Refusing takes a long way through the banner

- Area: Consent. Default severity: advisory.
- Detector: `scanner/passes/differ#refusal_buried` (family `consent`).
- Remedy in DE: `cns-07-shorten-the-refusal` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 7(3) `GDPR:7:3`; GDPR Art. 12(1) `GDPR:12:1`.
- Remedy in DK: `cns-07-shorten-the-refusal` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 7(3) `GDPR:7:3`; GDPR Art. 12(1) `GDPR:12:1`.
- Guide: `cns-07` (da, de, en).
- Fixtures that must raise it: banner-two-layer.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## DPA-01 · A supplier processes personal data for the company without an agreement

- Area: Contracts. Default severity: serious.
- Detector: `scanner/agreements#none` (no scanner family: verified another way).
- Remedy in DE: `dpa-01-processing-agreement` v2 (generated_artefact, verified by artefact_published).
- Rests on in DE: GDPR Art. 28(3) `GDPR:28:3`.
- Remedy in DK: `dpa-01-processing-agreement` v2 (generated_artefact, verified by artefact_published).
- Rests on in DK: GDPR Art. 28(3) `GDPR:28:3`.
- Guide: `dpa-01` (da, de, en).
- Fixtures that must raise it: **none**.
- Fixtures that must not: **none**.

## DPA-02 · The supplier's processing agreement cannot be found or read

- Area: Contracts. Default severity: serious.
- Detector: `scanner/agreements#unfindable` (no scanner family: verified another way).
- Remedy in DE: `dpa-02-obtain-the-agreement` v1 (self_fix, verified by attestation).
- Rests on in DE: GDPR Art. 28(3) `GDPR:28:3`; GDPR Art. 28(9) `GDPR:28:9`.
- Remedy in DK: `dpa-02-obtain-the-agreement` v1 (self_fix, verified by attestation).
- Rests on in DK: GDPR Art. 28(3) `GDPR:28:3`; GDPR Art. 28(9) `GDPR:28:9`.
- Guide: `dpa-02` (da, de, en).
- Fixtures that must raise it: **none**.
- Fixtures that must not: **none**.

## DPA-03 · The processing agreement leaves out things it has to set out

- Area: Contracts. Default severity: serious.
- Detector: `agent/agreement-analysis#inadequate` (no scanner family: verified another way).
- Remedy in DE: `dpa-03-close-the-gaps` v1 (self_fix, verified by attestation).
- Rests on in DE: GDPR Art. 28(3) `GDPR:28:3`.
- Remedy in DK: `dpa-03-close-the-gaps` v1 (self_fix, verified by attestation).
- Rests on in DK: GDPR Art. 28(3) `GDPR:28:3`.
- Guide: `dpa-03` (da, de, en).
- Fixtures that must raise it: **none**.
- Fixtures that must not: **none**.

## EXP-01 · Public certificate logs name hosts that look internal or unfinished

- Area: Security. Default severity: serious.
- Detector: `scanner/ct/enumerate#exposed_hosts` (family `ct`).
- Remedy in DE: `exp-01-review-named-hosts` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(f) `GDPR:5:1:f`.
- Remedy in DK: `exp-01-review-named-hosts` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(f) `GDPR:5:1:f`.
- Guide: `exp-01` (da, de, en).
- Fixtures that must raise it: **none**.
- Fixtures that must not: **none**.

## FPR-01 · A script reads the canvas back to fingerprint the visitor

- Area: Observation. Default severity: serious.
- Detector: `scanner/checks/replay#canvas` (family `replay`).
- Remedy in DE: `fpr-01-canvas-fingerprint` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 6(1) `GDPR:6:1`.
- Remedy in DK: `fpr-01-canvas-fingerprint` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 6(1) `GDPR:6:1`.
- Guide: `fpr-01` (da, de, en).
- Fixtures that must raise it: replay-unmasked.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## FPR-02 · A script measures dozens of fonts to fingerprint the visitor

- Area: Observation. Default severity: serious.
- Detector: `scanner/checks/replay#font` (family `replay`).
- Remedy in DE: `fpr-02-font-fingerprint` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 6(1) `GDPR:6:1`.
- Remedy in DK: `fpr-02-font-fingerprint` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 6(1) `GDPR:6:1`.
- Guide: `fpr-02` (da, de, en).
- Fixtures that must raise it: replay-unmasked.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## FPR-03 · A script renders silent audio to fingerprint the visitor

- Area: Observation. Default severity: serious.
- Detector: `scanner/checks/replay#audio` (family `replay`).
- Remedy in DE: `fpr-03-audio-fingerprint` v2 (self_fix, verified by rescan).
- Rests on in DE: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 6(1) `GDPR:6:1`.
- Remedy in DK: `fpr-03-audio-fingerprint` v2 (self_fix, verified by rescan).
- Rests on in DK: ePrivacy Art. 5(3) `ePrivacy:5:3`; GDPR Art. 6(1) `GDPR:6:1`.
- Guide: `fpr-03` (da, de, en).
- Fixtures that must raise it: replay-unmasked.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## FRM-01 · A consent box is ticked before the visitor touches it

- Area: Collection. Default severity: advisory.
- Detector: `scanner/checks/forms#preticked` (family `forms`).
- Remedy in DE: `frm-01-untick-the-box` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(2) `GDPR:7:2`.
- Remedy in DK: `frm-01-untick-the-box` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 4(11) `GDPR:4:11`; GDPR Art. 7(2) `GDPR:7:2`.
- Guide: `frm-01` (da, de, en).
- Fixtures that must raise it: preticked-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, insecure-forms, replay-unmasked.

## FRM-02 · One box bundles marketing consent with something the visitor must accept

- Area: Collection. Default severity: advisory.
- Detector: `scanner/checks/forms#bundled` (family `forms`).
- Remedy in DE: `frm-02-split-checkboxes` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 7(2) `GDPR:7:2`; GDPR Art. 7(4) `GDPR:7:4`.
- Remedy in DK: `frm-02-split-checkboxes` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 7(2) `GDPR:7:2`; GDPR Art. 7(4) `GDPR:7:4`.
- Guide: `frm-02` (da, de, en).
- Fixtures that must raise it: preticked-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, insecure-forms, lazy-tracker, reject-not-honoured, replay-unmasked.

## FRM-03 · A form collects personal details without saying what happens to them

- Area: Collection. Default severity: serious.
- Detector: `scanner/checks/forms#no_notice` (family `forms`).
- Remedy in DE: `frm-03-notice-at-collection` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 13(1) `GDPR:13:1`; GDPR Art. 12(1) `GDPR:12:1`.
- Remedy in DK: `frm-03-notice-at-collection` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 13(1) `GDPR:13:1`; GDPR Art. 12(1) `GDPR:12:1`.
- Guide: `frm-03` (da, de, en).
- Fixtures that must raise it: insecure-forms, preticked-forms, replay-unmasked.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## POL-01 · No privacy policy could be found

- Area: Notice. Default severity: serious.
- Detector: `scanner/discovery/policies#missing` (family `policies`).
- Remedy in DE: `pol-01-write-privacy-policy` v2 (generated_artefact, verified by artefact_published).
- Rests on in DE: GDPR Art. 13(1) `GDPR:13:1`; GDPR Art. 12(1) `GDPR:12:1`.
- Remedy in DK: `pol-01-write-privacy-policy` v2 (generated_artefact, verified by artefact_published).
- Rests on in DK: GDPR Art. 13(1) `GDPR:13:1`; GDPR Art. 12(1) `GDPR:12:1`.
- Guide: `pol-01` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, hosted-fonts, preticked-forms, us-tag-manager.

## POL-05 · The site sends data to a company the privacy policy does not name

- Area: Notice. Default severity: serious.
- Detector: `db/drift#recipient_not_named` (no scanner family: verified another way).
- Remedy in DE: `pol-05-name-the-recipient` v2 (generated_artefact, verified by artefact_published).
- Rests on in DE: GDPR Art. 13(1)(e) `GDPR:13:1:e`; GDPR Art. 5(1)(a) `GDPR:5:1:a`.
- Remedy in DK: `pol-05-name-the-recipient` v2 (generated_artefact, verified by artefact_published).
- Rests on in DK: GDPR Art. 13(1)(e) `GDPR:13:1:e`; GDPR Art. 5(1)(a) `GDPR:5:1:a`.
- Guide: `pol-05` (da, de, en).
- Fixtures that must raise it: **none**.
- Fixtures that must not: **none**.

## REC-01 · A session-recording tool watches pages where people type sensitive details

- Area: Observation. Default severity: serious.
- Detector: `scanner/checks/replay#replay_on_sensitive` (family `replay`).
- Remedy in DE: `rec-01-mask-and-exclude-checkout` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 6 `GDPR:6`; GDPR Art. 35 `GDPR:35`.
- Remedy in DK: `rec-01-mask-and-exclude-checkout` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 6 `GDPR:6`; GDPR Art. 35 `GDPR:35`.
- Guide: `rec-01` (da, de, en).
- Fixtures that must raise it: replay-unmasked.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## SEC-01 · The site answers over plain HTTP without sending visitors to HTTPS

- Area: Security. Default severity: blocking.
- Detector: `scanner/checks/security#transport` (family `security`).
- Remedy in DE: `sec-01-redirect-to-https` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(f) `GDPR:5:1:f`.
- Remedy in DK: `sec-01-redirect-to-https` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(f) `GDPR:5:1:f`.
- Guide: `sec-01` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## SEC-02 · A form sends what people type over plain HTTP

- Area: Security. Default severity: blocking.
- Detector: `scanner/checks/security#form_downgrade` (family `security`).
- Remedy in DE: `sec-02-https-form-hsts` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`.
- Remedy in DK: `sec-02-https-form-hsts` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`.
- Guide: `sec-02` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, lazy-tracker, preticked-forms, reject-not-honoured, replay-unmasked.

## SEC-03 · The site does not tell browsers to stay on HTTPS

- Area: Security. Default severity: serious.
- Detector: `scanner/checks/security#hsts` (family `security`).
- Remedy in DE: `sec-03-hsts` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`.
- Remedy in DK: `sec-03-hsts` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`.
- Guide: `sec-03` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, hosted-fonts, us-tag-manager.

## SEC-04 · An HTTPS page loads pieces over plain HTTP

- Area: Security. Default severity: serious.
- Detector: `scanner/checks/security#mixed_content` (family `security`).
- Remedy in DE: `sec-04-mixed-content` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`.
- Remedy in DK: `sec-04-mixed-content` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`.
- Guide: `sec-04` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## SEC-05 · The site hands the full page address to other services

- Area: Security. Default severity: advisory.
- Detector: `scanner/checks/security#referrer_policy` (family `security`).
- Remedy in DE: `sec-05-referrer-policy` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(c) `GDPR:5:1:c`.
- Remedy in DK: `sec-05-referrer-policy` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(c) `GDPR:5:1:c`.
- Guide: `sec-05` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## SEC-06 · The basic security headers are missing

- Area: Security. Default severity: advisory.
- Detector: `scanner/checks/security#security_headers` (family `security`).
- Remedy in DE: `sec-06-security-headers` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`.
- Remedy in DK: `sec-06-security-headers` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`.
- Guide: `sec-06` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## SEC-07 · Files that should never be public are reachable

- Area: Security. Default severity: serious.
- Detector: `scanner/checks/security#exposed_paths` (family `security`).
- Remedy in DE: `sec-07-exposed-paths` v2 (self_fix, verified by rescan).
- Rests on in DE: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(f) `GDPR:5:1:f`.
- Remedy in DK: `sec-07-exposed-paths` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 32(1) `GDPR:32:1`; GDPR Art. 5(1)(f) `GDPR:5:1:f`.
- Guide: `sec-07` (da, de, en).
- Fixtures that must raise it: insecure-forms.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## TRF-01 · Visitors’ requests go to a service established outside the EEA

- Area: Transfers. Default severity: serious.
- Detector: `scanner/checks/recipients#transfers` (family `recipients`).
- Remedy in DE: `trf-01-european-alternatives` v2 (partner_alternative, verified by rescan).
- Rests on in DE: GDPR Art. 44–49 `GDPR:44`; Case law CJEU, C-311/18 `CJEU:C-311/18`.
- Remedy in DK: `trf-01-european-alternatives` v2 (partner_alternative, verified by rescan).
- Rests on in DK: GDPR Art. 44–49 `GDPR:44`; Case law CJEU, C-311/18 `CJEU:C-311/18`.
- Guide: `trf-01` (da, de, en).
- Fixtures that must raise it: hosted-fonts, us-tag-manager.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa.

## VND-06 · Web fonts are fetched from someone else’s server

- Area: Recipients. Default severity: advisory.
- Detector: `scanner/checks/recipients#third_party_fonts` (family `recipients`).
- Remedy in DE: `vnd-06-self-host-fonts` v2 (self_fix, verified by rescan).
- Rests on in DE: Case law LG München I, 3 O 17493/20 `LG München I:3 O 17493/20`; GDPR Art. 6(1) `GDPR:6:1`.
- Remedy in DK: `vnd-06-self-host-fonts` v2 (self_fix, verified by rescan).
- Rests on in DK: GDPR Art. 6(1) `GDPR:6:1`; Case law LG München I, 3 O 17493/20 `LG München I:3 O 17493/20`.
- Guide: `vnd-06` (da, de, en).
- Fixtures that must raise it: hosted-fonts.
- Fixtures that must not: clean-agency, clean-blog, clean-brochure, clean-shop-gated, clean-spa, reject-not-honoured, us-tag-manager.
