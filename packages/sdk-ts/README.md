# `@ori/sdk-ts` — generated TypeScript client

`src/schema.d.ts` is generated from `openapi/ori-v1.yaml`; `src/index.ts` is the ~20 lines that
bind a typed fetch client to it. Regenerate with `make sdk`.

The client is generated rather than hand-written on purpose. The premise of this project is
that the OpenAPI document is faithful enough to generate from, and a hand-written client would
hide exactly the gaps that premise needs tested. `make e2e-sdk` drives a real ori through this
client end to end.

## Generator quirk worth knowing

`openapi-typescript` treats a schema property that has a `default` as **non-optional**. For a
response that is correct — the server has already filled it in. For a **request body** it is
not: `CreateOriRequest` lists no `required` properties, so `type` and `noEnv` are optional per
the spec, yet the generated type demands them.

The obvious fix, `--default-non-nullable false`, is worse: it makes `openapi-fetch` resolve
several operations to `never` and nothing type-checks at all. So the generator default stands
and a caller passes the defaulted fields explicitly.

This is a generator behaviour, **not** a gap in `openapi-v1.yaml` — the spec is right. Worth
remembering before anyone "fixes" the spec by adding a `required` list, which would make the
fields genuinely mandatory and break compatibility with ori's real API.

## The `never` result types

`openapi-fetch` resolves the RESULT type of a few operations in this spec (`command`,
`readFile`, `writeFile`) to `never`, so `.data` and `.error` cannot be read from them even
though the calls work perfectly at runtime — `make e2e-sdk` exercises all of them against a
real ori and passes.

What is lost is narrow: request **bodies and params are still fully typed** (the type errors
were all on reading the result). `test/e2e/sdk.ts` funnels those three reads through one named
`res()` helper so the compromise sits in a single greppable place rather than as scattered
`as any`.

Do not "fix" this by editing `openapi/ori-v1.yaml`. The spec matches the published spec's published document;
the friction is in the generator/client pair. If it matters later, the options are a different
generator (openapi-generator's typescript-fetch, which is what ori's own npm package looks
like) or a hand-thin wrapper over `fetch` typed from `schema.d.ts` directly.
