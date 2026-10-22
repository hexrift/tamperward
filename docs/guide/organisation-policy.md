# Organisation policy floor

From 2.46.0, an operator can require a minimum policy outside the candidate repository.
Configure both values in the trusted hook launcher or protected CI job:

```sh
export TAMPERWARD_POLICY_FLOOR=/trusted/policy.yml
export TAMPERWARD_POLICY_FLOOR_SHA256=YOUR_64_CHARACTER_LOWERCASE_SHA256
tamperward check --diff main...HEAD
```

The pin is the SHA-256 of the file's exact bytes. The floor is ordinary policy YAML,
not a new repository `extends` key. Its real path must be outside the repository,
and the final entry must be a readable regular file, not a symlink or special file.
No remote retrieval, mutable tag resolution or fallback is attempted. A missing,
malformed, inaccessible, unknown-rule or differently pinned floor fails closed.
Both configuration values must be present together. A pin alone is an error.

The environment and its launcher are part of the operator's control plane. A candidate
that can remove both variables from the **authoritative** job can opt it out; do not
let repository-controlled workflow edits choose whether the floor runs or which pin
it uses. This feature does not install branch protection, secure a writable launcher,
or make a same-user local process into a trust boundary. Required protected CI remains
the authority. Never place the baseline or its trusted pin in candidate-controlled
inputs. The path check is an additional refusal, not proof of key/configuration custody.

## Repository overlays

An absent repository policy inherits the floor. An existing policy overlays it, with
omitted values inherited rather than dropping organisation requirements. A declared
version must be at least the floor version. The floor's resolved defaults are inherited
as well as its explicit overrides; the repository can explicitly strengthen rules.
The same rules apply to policy read from a trusted Git revision, including one that
has no `.tamperward.yml`. The pure parser remains independent of environment configuration.

The loader refuses:

- Disabling a floor-enabled rule, or lowering a floor block to warn.
- Ignore or per-rule exclusion globs outside the floor's allowed literal sets.
  Removing exclusions is permitted; equivalent spellings are not inferred.
- Removing required sign-off severities or substituting the floor's ledger path.
- Substituting a required verifier command, backend or image; lowering its budget;
  or changing its input-glob set. A higher budget is permitted. A verify override
  block still requires a command, as in the ordinary policy schema.
- Changing declared protected category sets. Omitting the field inherits them;
  restating the identical set is permitted. Additional protected classifications
  can suppress source-only detectors, and additional verifier inputs can restore
  candidate source during adjudication, so v1 freezes these sets rather than
  treating every added glob as a proven strengthening.

This conservative contract deliberately does not solve semantic glob containment.
To change frozen classifications or verifier inputs, update the centrally reviewed
floor and its pin. A floor may omit `verify` to leave verifier selection to individual
repositories. Where it requires a command/budget, standalone `verify --cmd` and
`--budget` cannot weaken those requirements.

## Updates and evidence

The baseline's exact-byte digest is part of the effective policy and therefore the
verification-state/receipt policy fingerprint. Changing the trusted floor or its pin
invalidates prior evidence even if the remaining resolved fields happen to match.
The envelope freezes the loaded policy before candidate execution; later untrusted
repository changes do not replace that snapshot.

Review a baseline update outside candidate control, distribute its regular file and
new pin together, and rerun verification. A repository cannot downgrade to another
baseline under the old pin. The operator can intentionally change the trust root;
the tool cannot distinguish an authorized central rollback from compromised operator
configuration. Signed verdict transport and live runtime qualification remain separate
M5 requirements.
