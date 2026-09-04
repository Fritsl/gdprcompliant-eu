# Manual smoke checklist

What the delivery gate cannot see: a dozen things that need eyes. Each line is a
yes-or-no observation, not a judgement; if the answer is no, that is the finding. The
gate (`pnpm run gate`) appends this list to its report so the ticks sit beside the verdict.

Open the app at the address the gate report names, in a private browser window.

1. The front page loads with the scan field focused, and pressing Enter on `usikker.test` starts a scan without an error page?
2. The scan page shows every stage ticking to a mark within two minutes, and the case link appears?
3. On the case page, the first open finding is marked as the one to do now, and its evidence drawer opens?
4. Printing the case page (Ctrl+P preview) shows no navigation, no buttons, and every finding on the paper?
5. Switching the language to Danish changes every visible string, and no English remains on the case page?
6. Switching to German does the same, and the umlauts and ß are shown as letters, not as question marks?
7. On a phone-width window (375 px), the front page and the case page can be read and used without horizontal scrolling?
8. The trust page for a published case shows a dated statement and no image, badge or word that looks like a seal?
9. The status report PDF opens, is dated, quotes at least one article in full, and carries the disclaimer on the last page?
10. The supply-chain map renders as an image with the company at the top and every supplier box linking to its evidence?
11. The advisor page shows the notice that it is an assistant, not counsel, above the question field?
12. Asking the advisor about cameras on a case with no camera evidence returns a refusal that names the camera question?
13. The timeline page lists the scan, the findings and every answer given, each with who did it and when?
14. Deleting a test case from its page makes the case, its report and its export answer 404?
