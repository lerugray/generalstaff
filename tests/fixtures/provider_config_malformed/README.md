# Malformed provider_config.yaml fixtures

One file per error case covered by `tests/providers.registry.test.ts`
under the `loadProviderRegistry — malformed fixtures` suite. Each
fixture targets a single branch of `validateDescriptor` /
`validateRoutes` / the top-level parser so a regression in the
registry loader produces a clear failing case.

The golden-path example lives at `provider_config.yaml.example` in
the repo root and is deliberately not duplicated here.

| File | Branch |
| --- | --- |
| `a_yaml_parse_error.yaml` | raw YAML that fails `yaml.parse` |
| `b_providers_not_array.yaml` | top-level `providers` is a map, not an array |
| `c_missing_id.yaml` | provider entry missing `id` |
| `d_missing_kind.yaml` | provider entry missing `kind` |
| `e_unknown_kind.yaml` | provider entry with `kind: gemini` (not in Phase 2) |
| `f_missing_model.yaml` | provider entry missing `model` |
| `g_routes_unknown_provider.yaml` | route references an undeclared provider id |
| `h_routes_unknown_role.yaml` | `routes` has an unknown role key (`reviewer`) |
| `i_empty.yaml` | fully empty file — lenient fallback returns empty registry |
