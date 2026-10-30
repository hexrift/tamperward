from pathlib import Path
import sys

root = Path(sys.argv[2]).resolve()
source = root / 'src/cli/doctor.ts'

def replace_once(text, old, new):
    assert text.count(old) == 1, f'expected exactly one occurrence: {old[:100]!r}; got {text.count(old)}'
    return text.replace(old, new, 1)

if sys.argv[1] == 'tests':
    text = source.read_text()
    text = replace_once(text, 'function githubAuthority(\n  opts: DoctorOpts,\n  cwd: string,\n', '/** @internal The transport seam exercises collection and fallback without live API access. */\nexport function githubAuthority(\n  opts: DoctorOpts,\n  cwd: string,\n  readApi: typeof githubApi = githubApi,\n')
    start = text.index('export function githubAuthority(')
    end = text.index('\nfunction verifyJobs(', start)
    part = text[start:end]
    part = part.replace('githubApi(cwd,', 'readApi(cwd,').replace('branchProtection = githubApi(', 'branchProtection = readApi(')
    text = text[:start] + part + text[end:]
    source.write_text(text)
    (root / 'test/doctor-authority-evidence.test.ts').write_text((Path(__file__).parent / 'doctor-authority-evidence.test.ts').read_text())
elif sys.argv[1] == 'fix':
    text = source.read_text()
    text = replace_once(text, "  if (Array.isArray(snapshot.bypassActors) && snapshot.bypassActors.length > 0) {\n    findings.push('remove unintended ruleset bypass actors');\n  }", "  // GitHub omits bypass_actors when the requester cannot inspect it. Absence\n  // is unknown evidence, not an empty grant list (#795).\n  if (!Array.isArray(snapshot.bypassActors)) {\n    findings.push('ruleset bypass actors could not be verified');\n  } else if (snapshot.bypassActors.length > 0) {\n    findings.push('remove unintended ruleset bypass actors');\n  }")
    text = replace_once(text, "    rules = readApi(cwd, 'repos/' + repo + '/rules/branches/' + encodeURIComponent(branch));", "    rules = readApi(cwd, 'repos/' + repo + '/rules/branches/' + encodeURIComponent(branch));\n    if (!Array.isArray(rules)) throw new Error('branch rules response is not an array');")
    text = replace_once(text, "  let findings = evaluateGitHubProtection(\n    { rules, bypassActors },\n    'tamperward',\n    REPOSITORY_REQUIRED_CHECKS,\n  );\n  if (rulesetInspectionError) {\n    findings.push('active main ruleset bypass actors could not be verified: ' + rulesetInspectionError.message);\n  }", "  // Fallback can supply a missing requirement, but cannot discard adverse or\n  // unknown observations or silently replace the requested check contract.\n  const inspectionFindings: string[] = [];\n  if (rulesError) inspectionFindings.push('branch rules could not be verified: ' + rulesError.message);\n  if (rulesetInspectionError) {\n    inspectionFindings.push('active main ruleset bypass actors could not be verified: ' + rulesetInspectionError.message);\n  }\n  const evaluate = (branchProtection?: unknown): string[] => [\n    ...evaluateGitHubProtection(\n      { rules, bypassActors, branchProtection },\n      'tamperward',\n      REPOSITORY_REQUIRED_CHECKS,\n    ),\n    ...inspectionFindings,\n  ];\n  let findings = evaluate();")
    text = replace_once(text, "  findings = evaluateGitHubProtection({ rules, branchProtection });", "  findings = evaluate(branchProtection);")
    source.write_text(text)
    tests = root / 'test/doctor-ci.test.ts'
    text = tests.read_text()
    # These legacy helper fixtures intentionally isolate positive policy requirements.
    # Make their assumption of fully inspected, empty bypass grants explicit.
    text = text.replace('evaluateGitHubProtection({', 'evaluateGitHubProtection({ bypassActors: [],')
    tests.write_text(text)
    changelog = root / 'CHANGELOG.md'
    entry = "## [2.47.1] — 2026-10-30\n\n### Fixed\n\n- Preserve adverse and unknown GitHub authority evidence across classic branch-\n  protection fallback in `doctor --github` (#795). Missing/malformed bypass lists\n  and unavailable branch-rule evidence cannot certify authority; fallback retains\n  the same required-check contract. Collector-level regressions exercise both\n  successful composition and refusal paths.\n\n"
    changelog.write_text(replace_once(changelog.read_text(), '# Changelog\n\n', '# Changelog\n\n' + entry))
else:
    raise SystemExit('expected tests or fix')
