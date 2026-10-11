# Publishing dawg

dawg is a public MIT package at `@hraness/dawg`. Each stable release is one
tarball, built once by the tag workflow, `.github/workflows/release.yml`, and
served byte for byte from an immutable GitHub Release and from npm. npm
receives it through npm trusted publishing with OIDC provenance, so no
maintainer credential touches a routine release.

## Release a version

1. In a pull request, set the new `version` in `package.json` and add a
   `## <version>` section to `CHANGELOG.md`. The workflow copies that section
   onto the Release page.
2. Merge the pull request once the required `check` passes.
3. That is all. When Check passes on a `main` commit whose `package.json`
   version has no tag yet, `auto-tag.yml` creates the annotated tag
   `v<version>` (message `dawg <version>`) on that commit with the
   `hraness-release-tagger` GitHub App. Tags pushed with `GITHUB_TOKEN` would
   not start other workflows, so the app is required.
4. The tag starts `release.yml`, which publishes the GitHub Release and then
   npm.

If Check fails on the version-bump commit, fix `main` through a normal pull
request, or re-run Check if the failure was flaky. The next green Check on
`main` tags the version, so a failed bump never skips a release.

A version that is not stable `MAJOR.MINOR.PATCH`, already has a tag, or is
older than the latest release tag is never tagged. To tag by hand, create an
annotated tag on a commit that is on `main`, then push it:

```sh
git fetch origin main
git tag -a v<version> -m "dawg <version>" <commit>
git push origin v<version>
```

Never reuse, move or delete a tag that has a published Release.

## What the workflow does

`sink` runs `.github/workflows/sink.yml` (the same workflow Check runs on every
pull request) on the tagged commit. It builds the native audio sink,
`native/sink`, for darwin-arm64 and darwin-x64 on macOS runners and for
linux-x64 and linux-arm64 on Ubuntu 22.04 runners (glibc 2.35 floor), runs its
unit tests and the headless null-device smoke test where the runner can execute
the library, and uploads one library per platform. Check's `package` job also
stages those libraries, packs, installs and runs `native/verify-install.sh` on
every pull request, so the release path is exercised before a tag exists.

`release` (needs `sink`; permissions `contents: write`, `id-token: write`,
`attestations: write`):

1. Checks that the tag is `v` plus the `package.json` version and that the
   tagged commit is on `main`.
2. Runs `bun run check`, then downloads the four sink libraries into
   `native/prebuilt/<platform>-<arch>/` and writes
   `native/prebuilt/manifest.json` with `native/stage-prebuilt.sh`, which
   fails unless every platform is present.
3. Packs `hraness-dawg-<version>.tgz` with `bun pm pack`. The package `files`
   include the libraries and the manifest, so the tarball and npm carry them.
   Each library is also copied out as `libdawg_sink-<platform>-<arch>.dylib`
   or `.so`. `SHA256SUMS` lists the tarball first, then the four libraries.
4. Runs `native/verify-install.sh`: installs the tarball into a temporary
   `BUN_INSTALL`, runs `dawg --help`, and requires `dawg doctor --json` to
   report the linux-x64 sink verified and loaded.
5. Attests build provenance for the tarball and the four libraries, attaches
   them and `SHA256SUMS` to a draft Release, and publishes it in one step so it
   becomes immutable with every file in place.

`npm` (environment `npm-release`, permissions `contents: read` and
`id-token: write` only):

1. Installs Node 24.19.0 and requires npm 11.5.1 or newer, the first npm with
   trusted publishing.
2. Downloads the tarball and `SHA256SUMS` from the published Release, runs
   `sha256sum -c --ignore-missing` (the libraries are inside the tarball, so
   only its line is checked), and requires the sha256 the `release` job built.
3. Reads the version's integrity from the npm registry. The same sha512 means
   it is already published and the job succeeds. Different bytes fail the job.
   A missing package or version runs
   `npm publish <tarball> --provenance --access public`, then waits up to ten
   minutes for npm to report the expected integrity.

The `npm` job runs only after the Release is published and never changes it. If
npm fails, the GitHub Release stays as it is; fix the cause and rerun the failed
job with `gh run rerun <run-id> --failed -R hraness/dawg`.

## Native sink at runtime

Nothing is compiled when dawg is installed: the package has no install
scripts. At startup `src/audio/native.ts` picks
`native/prebuilt/<platform>-<arch>/`, checks the library's sha256 against
`manifest.json`, and only then calls `dlopen`. A platform without a prebuilt
(Windows, musl, 32-bit), a missing or mismatched file, an ABI mismatch, or a
library that fails to load (for example no `libasound.so.2` on Linux) falls
back to ffplay, SoX or afplay; `dawg doctor` and the backend detail say why.
`DAWG_AUDIO_NATIVE=0` turns the sink off, and `DAWG_SINK_LIB=<path>` loads a
local `cargo build` unverified, for development.

To verify a library from a Release by itself:

```sh
gh release download v<version> --repo hraness/dawg --pattern 'libdawg_sink-*' --pattern SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify libdawg_sink-darwin-arm64.dylib --repo hraness/dawg
```

The first release that ships the libraries is the first version bump after
this workflow change; earlier releases have none and always use the
fallback.

## Repository settings

- Repository: auto-merge allowed, squash merges on, head branches deleted on
  merge.
- Ruleset `Protect main delivery` on the default branch, with no bypass actors:
  blocks deletion and non-fast-forward pushes, requires a pull request (0
  approvals), and requires the `check` status (not strict).
- Ruleset `Immutable version tags` on `refs/tags/v*`, excluding nothing, with no
  bypass actors: blocks tag updates and deletions, so creating a tag is allowed.
- Environment `npm-release`: `can_admins_bypass` false, no reviewers or wait
  timer, and one custom deployment policy allowing only tags matching `v*`.
- Dependabot proposes weekly bun and GitHub Actions updates, and
  `dependabot-auto-merge.yml` turns on squash auto-merge for them, so they merge
  once `check` passes.

Check them with:

```sh
gh api repos/hraness/dawg --jq '{allow_auto_merge, allow_squash_merge, delete_branch_on_merge}'
gh api repos/hraness/dawg/rulesets --jq '.[].id' | while read -r id; do gh api "repos/hraness/dawg/rulesets/$id"; done
gh api repos/hraness/dawg/environments/npm-release
gh api repos/hraness/dawg/environments/npm-release/deployment-branch-policies
```

## npm trusted publisher

npm cannot configure a trusted publisher for a package that does not exist yet,
so the first version is published once by hand with maintainer two-factor
authentication, from the exact Release tarball:

```sh
npm login
gh release download v0.9.0 --repo hraness/dawg
shasum -a 256 -c SHA256SUMS
gh attestation verify hraness-dawg-0.9.0.tgz --repo hraness/dawg
npm publish "$PWD/hraness-dawg-0.9.0.tgz" --access public
npm trust github @hraness/dawg --repo hraness/dawg --file release.yml --environment npm-release --allow-publish --yes
npm trust list @hraness/dawg
```

Then rerun the failed `npm` job of the `v0.9.0` release run. It finds the same
integrity on npm and succeeds without publishing again. Every later version is
published only by the workflow's OIDC identity. Do not add a long-lived npm
token.
