# Cookie database store

The runtime store for cookie classification (S-06): `open-cookie-database.csv` and
`version.json`, replaced together by the scheduled refresh job. The copy checked in here
is the first version so that a fresh checkout can classify; the job's copy is the one
that counts, and `version.json` says which one answered.

Source: the [Open Cookie Database](https://github.com/jkwakman/Open-Cookie-Database),
Apache License 2.0. The job fetches it from an EU mirror, `data.gdprcompliant.eu`,
because the upstream repository is hosted outside the EEA and the system makes no
requests there. The mirror is refreshed by ops from upstream.

A cookie the database does not know is classified `unknown`. It is never guessed.
