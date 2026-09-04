# Business registry adapters

One interface (`types.ts`), one file per country. An adapter answers with what the
register says about an entity, as the register says it: name, register number, status,
address, the sector where the register files one, the headcount band where the register
bands it, the parent where the register names one. What the register does not carry is
`unknown`. No adapter infers a headcount, a sector or a parent from anything.

| Adapter | Country | Register | Terms | Pace | Credentials |
| --- | --- | --- | --- | --- | --- |
| `cvr` | DK | Det Centrale Virksomhedsregister, system-to-system interface at `distribution.virk.dk` | Public register data under a system-to-system agreement with Erhvervsstyrelsen | 1 query per second | Yes, `CVR_USER` and `CVR_PASSWORD` |
| `offeneregister` | DE | Handelsregister, through OffeneRegister.de at `db.offeneregister.de` | ODbL 1.0, attribution "Datenquelle: OffeneRegister.de (OKF Deutschland), ODbL 1.0" | 1 query per 2 seconds | No |

Each adapter keeps its own pace (`paced` in `types.ts`): two calls closer together than
the terms allow are spaced by the adapter, whatever the caller does. Hosts are declared in
`packages/config/endpoints.json` with purpose `registry`; a call to any other host is
refused before it leaves.

## Adding a country

Add one file that exports `create<Name>Adapter(): RegistryAdapter` with the register's
terms, pace and credentials, and add it to `REGISTRY_ADAPTERS` in `index.ts`. The
contract suite (`tests/integration/registry-adapters.test.ts`) runs the same assertions
over every adapter in that list; record its cassettes with `GC_NETWORK=record`.

## Cassettes

The contract suite records its own cassettes into a temporary directory from a stand-in
upstream that answers in each register's documented response shape, then replays them
with the network pulled; nothing synthetic is checked in under `fixtures/cassettes`. A
live recording (`GC_NETWORK=record`, real credentials) lands under
`fixtures/cassettes/registry-<id>/` and is what a launch runs against; read the diff.
