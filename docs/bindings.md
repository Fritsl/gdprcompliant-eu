# Jurisdiction bindings

Generated from `packages/findings/content/bindings/*.json` by `scripts/bindings-doc.ts`. A finding
type is the same finding everywhere; what it rests on, who would hear a complaint and which
guide explains it are bound per jurisdiction, here. Every citation resolves in the corpus
(`pnpm check:citations`); every type the product can raise is bound in every supported
jurisdiction (`pnpm check:finding-completeness`). Detector code names no article.

## DE

Table version 1. Authority: Die Datenschutzaufsichtsbehörde des Bundeslandes (https://www.bfdi.bund.de/DE/Service/Anschriften/Laender/Laender-node.html).
Not yet reviewed by a lawyer.

| Finding | Area | Rests on | Guide |
| --- | --- | --- | --- |
| AI-03 |  | GDPR Art. 28(3) — a processor needs a contract `GDPR:28:3`<br>GDPR Art. 44 — transfers outside the EEA need a basis `GDPR:44` | ai-03 v1 |
| CNS-01 |  | ePrivacy Art. 5(3) — consent before storage or access `ePrivacy:5:3`<br>GDPR Art. 4(11) — what consent is `GDPR:4:11`<br>GDPR Art. 7(1) — the controller must be able to show consent was given `GDPR:7:1` | cns-01 v1 |
| CNS-02 |  | ePrivacy Art. 5(3) — consent before storage or access `ePrivacy:5:3`<br>GDPR Art. 7(3) — withdrawal as easy as consent `GDPR:7:3` | cns-02 v1 |
| CNS-09 |  | ePrivacy Art. 5(3) — consent before storage or access `ePrivacy:5:3`<br>GDPR Art. 13(1)(e) — recipients must be named `GDPR:13:1:e` | cns-09 v1 |
| DPA-01 |  | GDPR Art. 28(3) — required content of a processor agreement `GDPR:28:3` | dpa-01 v1 |
| EXP-01 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(f) — integrity and confidentiality `GDPR:5:1:f` | exp-01 v1 |
| FPR-01 | Observation | ePrivacy Art. 5(3) — access to the terminal equipment needs consent `ePrivacy:5:3`<br>GDPR Art. 6(1) — a lawful basis for the processing `GDPR:6:1` | fpr-01 v1 |
| FPR-02 | Observation | ePrivacy Art. 5(3) — access to the terminal equipment needs consent `ePrivacy:5:3`<br>GDPR Art. 6(1) — a lawful basis for the processing `GDPR:6:1` | fpr-02 v1 |
| FPR-03 | Observation | ePrivacy Art. 5(3) — access to the terminal equipment needs consent `ePrivacy:5:3`<br>GDPR Art. 6(1) — a lawful basis for the processing `GDPR:6:1` | fpr-03 v1 |
| FRM-01 | Collection | GDPR Art. 4(11) — consent is an affirmative act `GDPR:4:11`<br>GDPR Art. 7(2) — a consent request is clearly distinguishable `GDPR:7:2` | frm-01 v1 |
| FRM-02 | Collection | GDPR Art. 7(2) — a consent request is clearly distinguishable `GDPR:7:2`<br>GDPR Art. 7(4) — consent tied to a service is not freely given `GDPR:7:4` | frm-02 v1 |
| FRM-03 | Collection | GDPR Art. 13(1) — information at the time data are obtained `GDPR:13:1`<br>GDPR Art. 12(1) — in a concise, transparent form `GDPR:12:1` | frm-03 v1 |
| POL-01 | Notice | GDPR Art. 13(1) — information at the time data are obtained `GDPR:13:1`<br>GDPR Art. 12(1) — in a concise, transparent form `GDPR:12:1` | pol-01 v1 |
| POL-04 |  | GDPR Art. 13(2)(a) — the retention period, or how it is decided `GDPR:13:2:a` | pol-04 v1 |
| POL-09 |  | GDPR Art. 13(2)(d) — the right to lodge a complaint with a supervisory authority `GDPR:13:2:d` | pol-09 v1 |
| REC-01 | Observation | GDPR Art. 6 — a lawful basis for the processing `GDPR:6`<br>GDPR Art. 35 — an impact assessment for high-risk processing `GDPR:35` | rec-01 v1 |
| SEC-01 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(f) — integrity and confidentiality `GDPR:5:1:f` | sec-01 v1 |
| SEC-02 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-02 v1 |
| SEC-03 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-03 v1 |
| SEC-04 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-04 v1 |
| SEC-05 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(c) — data minimisation `GDPR:5:1:c` | sec-05 v1 |
| SEC-06 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-06 v1 |
| SEC-07 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(f) — integrity and confidentiality `GDPR:5:1:f` | sec-07 v1 |
| SUB-03 |  | GDPR Art. 28(2) — sub-processors need prior authorisation `GDPR:28:2` | sub-03 v1 |
| TRF-01 |  | GDPR Art. 44–49 — transfers outside the EEA need a basis `GDPR:44` | trf-01 v1 |
| VND-06 |  | Case law LG München I, 3 O 17493/20 — damages for embedded web fonts `LG München I:3 O 17493/20`<br>GDPR Art. 6(1) — a lawful basis for passing the visitor’s address to the font host `GDPR:6:1` | vnd-06 v1 |
| VND-11 |  | GDPR Art. 13(1)(e) — recipients or categories of recipients `GDPR:13:1:e` | vnd-11 v1 |

## DK

Table version 1. Authority: Datatilsynet (https://www.datatilsynet.dk/).
Not yet reviewed by a lawyer.

| Finding | Area | Rests on | Guide |
| --- | --- | --- | --- |
| AI-03 |  | GDPR Art. 28(3) — a processor needs a contract `GDPR:28:3`<br>GDPR Art. 44 — transfers outside the EEA need a basis `GDPR:44` | ai-03 v1 |
| CNS-01 |  | ePrivacy Art. 5(3) — consent before storage or access `ePrivacy:5:3`<br>GDPR Art. 4(11) — what consent is `GDPR:4:11`<br>GDPR Art. 7(1) — the controller must be able to show consent was given `GDPR:7:1` | cns-01 v1 |
| CNS-02 |  | ePrivacy Art. 5(3) — consent before storage or access `ePrivacy:5:3`<br>GDPR Art. 7(3) — withdrawal as easy as consent `GDPR:7:3` | cns-02 v1 |
| CNS-09 |  | ePrivacy Art. 5(3) — consent before storage or access `ePrivacy:5:3`<br>GDPR Art. 13(1)(e) — recipients must be named `GDPR:13:1:e` | cns-09 v1 |
| DPA-01 |  | GDPR Art. 28(3) — required content of a processor agreement `GDPR:28:3` | dpa-01 v1 |
| EXP-01 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(f) — integrity and confidentiality `GDPR:5:1:f` | exp-01 v1 |
| FPR-01 | Observation | ePrivacy Art. 5(3) — access to the terminal equipment needs consent `ePrivacy:5:3`<br>GDPR Art. 6(1) — a lawful basis for the processing `GDPR:6:1` | fpr-01 v1 |
| FPR-02 | Observation | ePrivacy Art. 5(3) — access to the terminal equipment needs consent `ePrivacy:5:3`<br>GDPR Art. 6(1) — a lawful basis for the processing `GDPR:6:1` | fpr-02 v1 |
| FPR-03 | Observation | ePrivacy Art. 5(3) — access to the terminal equipment needs consent `ePrivacy:5:3`<br>GDPR Art. 6(1) — a lawful basis for the processing `GDPR:6:1` | fpr-03 v1 |
| FRM-01 | Collection | GDPR Art. 4(11) — consent is an affirmative act `GDPR:4:11`<br>GDPR Art. 7(2) — a consent request is clearly distinguishable `GDPR:7:2` | frm-01 v1 |
| FRM-02 | Collection | GDPR Art. 7(2) — a consent request is clearly distinguishable `GDPR:7:2`<br>GDPR Art. 7(4) — consent tied to a service is not freely given `GDPR:7:4` | frm-02 v1 |
| FRM-03 | Collection | GDPR Art. 13(1) — information at the time data are obtained `GDPR:13:1`<br>GDPR Art. 12(1) — in a concise, transparent form `GDPR:12:1` | frm-03 v1 |
| POL-01 | Notice | GDPR Art. 13(1) — information at the time data are obtained `GDPR:13:1`<br>GDPR Art. 12(1) — in a concise, transparent form `GDPR:12:1` | pol-01 v1 |
| POL-04 |  | GDPR Art. 13(2)(a) — the retention period, or how it is decided `GDPR:13:2:a` | pol-04 v1 |
| POL-09 |  | GDPR Art. 13(2)(d) — the right to lodge a complaint with a supervisory authority `GDPR:13:2:d` | pol-09 v1 |
| REC-01 | Observation | GDPR Art. 6 — a lawful basis for the processing `GDPR:6`<br>GDPR Art. 35 — an impact assessment for high-risk processing `GDPR:35` | rec-01 v1 |
| SEC-01 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(f) — integrity and confidentiality `GDPR:5:1:f` | sec-01 v1 |
| SEC-02 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-02 v1 |
| SEC-03 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-03 v1 |
| SEC-04 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-04 v1 |
| SEC-05 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(c) — data minimisation `GDPR:5:1:c` | sec-05 v1 |
| SEC-06 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1` | sec-06 v1 |
| SEC-07 | Security | GDPR Art. 32(1) — appropriate technical measures `GDPR:32:1`<br>GDPR Art. 5(1)(f) — integrity and confidentiality `GDPR:5:1:f` | sec-07 v1 |
| SUB-03 |  | GDPR Art. 28(2) — sub-processors need prior authorisation `GDPR:28:2` | sub-03 v1 |
| TRF-01 |  | GDPR Art. 44–49 — transfers outside the EEA need a basis `GDPR:44` | trf-01 v1 |
| VND-06 |  | GDPR Art. 6(1) — a lawful basis for passing the visitor’s address to the font host `GDPR:6:1`<br>Case law LG München I, 3 O 17493/20 — damages for embedded web fonts `LG München I:3 O 17493/20` | vnd-06 v1 |
| VND-11 |  | GDPR Art. 13(1)(e) — recipients or categories of recipients `GDPR:13:1:e` | vnd-11 v1 |
