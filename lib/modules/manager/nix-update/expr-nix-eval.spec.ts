import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  collapseExpr,
  exprForComposerVendor,
  exprForGoModules,
  exprForMixFodDeps,
  exprForZigDeps,
} from './expr.ts';

// The expressions in expr.ts are nix source assembled as TypeScript strings:
// neither tsc nor a `toContain` assertion can tell a well-formed expression
// from one that parses but means the wrong thing, and several real defects
// (a stale nixpkgs path, a guard that aborted on EOL-toolchain aliases, a
// builder whose result attribute didn't exist) were invisible to both.
//
// These tests close that gap by handing the generated nix to a real `nix eval`.
// They need a nix on PATH and network access to a nixpkgs, so they are opt-in:
//
//   NIX_UPDATE_EVAL_TESTS=1 pnpm vitest run lib/modules/manager/nix-update/
//
// The flake evaluated against is this repository's own, which pins a nixpkgs —
// no external checkout required.
const enabled = process.env.NIX_UPDATE_EVAL_TESTS === '1';
const exec = promisify(execFile);
const FLAKE = process.cwd();

// A fetcher call that evaluates without fetching anything.
const SRC = `(let f = builtins.getFlake ${JSON.stringify(FLAKE)}; p = f.inputs.nixpkgs.legacyPackages.\${builtins.currentSystem}; in p.fetchurl { url = "https://example.invalid/x.tar.gz"; hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; })`;

const VEND = { pname: 'probe', version: '1.0', srcExpr: SRC };

async function nixEval(
  expr: string,
  apply?: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout } = await exec(
      'nix',
      [
        '--extra-experimental-features',
        'nix-command flakes',
        'eval',
        '--impure',
        '--raw',
        '--expr',
        collapseExpr(expr),
        ...(apply ? ['--apply', apply] : []),
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return { ok: true, out: stdout, err: '' };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, out: '', err: e.stderr ?? e.message ?? '' };
  }
}

/** Evaluate an expression to a derivation path. Resolves to nix's stderr on failure. */
function evalDrv(expr: string): Promise<{
  ok: boolean;
  out: string;
  err: string;
}> {
  return nixEval(expr, 'd: d.drvPath');
}

// Which versioned attr to pin to has to be discovered from the runner, never
// hard-coded: this repo's nixpkgs carries `go_1_27` as a *release candidate*
// ("1.27rc2"), so a literal "1.27.0" silently fails the guard and every
// assertion below would pass against the unpinned fallback — the same vacuous
// test this suite exists to prevent. Returns "<attr> <version>" for a
// non-default, non-throwing attr, or "" when there is none to test with.
async function findNonDefault(
  prefix: string,
  defaultAttr: string,
): Promise<{ attr: string; version: string } | null> {
  const r = await nixEval(`
    let
      f = builtins.getFlake ${JSON.stringify(FLAKE)};
      p = f.inputs.nixpkgs.legacyPackages.\${builtins.currentSystem};
      cands = builtins.filter
        (n: builtins.match "${prefix}_[0-9]+_[0-9]+" n != null)
        (builtins.attrNames p);
      usable = builtins.filter (n:
        let v = builtins.tryEval (p.\${n}.version); in
        v.success && v.value != p.${defaultAttr}.version) cands;
    in if usable == [] then ""
       else "\${builtins.head usable} \${p.\${builtins.head usable}.version}"`);
  if (!r.ok) {
    // a nix failure must not read as "nothing usable to test with"
    throw new Error(`could not discover a ${prefix} toolchain: ${r.err}`);
  }
  const [attr, version] = r.out.split(' ');
  return attr && version ? { attr, version } : null;
}

describe.skipIf(!enabled)('modules/manager/nix-update/expr nix eval', () => {
  it('go: the pin selects exactly the canonical buildGoXModule', async () => {
    const go = await findNonDefault('go', 'go');
    expect(go).not.toBeNull();
    const { attr, version } = go!;

    const pinned = await evalDrv(
      exprForGoModules(
        FLAKE,
        { ...VEND, tools: [{ pname: 'go', version }] },
        'sha256',
      ),
    );
    const plain = await evalDrv(exprForGoModules(FLAKE, VEND, 'sha256'));
    expect(pinned.err).toBe('');
    expect(plain.err).toBe('');

    // the pin has to actually move the derivation, or it proves nothing
    expect(pinned.out).not.toBe(plain.out);

    // …and it has to land on precisely what nixpkgs' own buildGoXModule builds
    const canonical = await evalDrv(`
      let
        f = builtins.getFlake ${JSON.stringify(FLAKE)};
        runnerPkgs = f.inputs.nixpkgs.legacyPackages.\${builtins.currentSystem};
      in (runnerPkgs.buildGo${attr.replace('go_', '').replace('_', '')}Module {
        pname = "probe"; version = "1.0"; src = ${SRC};
        vendorHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      }).goModules`);
    expect(canonical.err).toBe('');
    expect(pinned.out).toBe(canonical.out);
  }, 600_000);

  it('go: an end-of-life toolchain falls back instead of aborting', async () => {
    // nixpkgs keeps removed toolchains as attrs that throw when forced. The
    // `? attr` test is true for them, so only tryEval keeps this evaluable.
    const r = await evalDrv(
      exprForGoModules(
        FLAKE,
        { ...VEND, tools: [{ pname: 'go', version: '1.23.12' }] },
        'sha256',
      ),
    );
    expect(r.err).not.toContain('end-of-life');
    expect(r.out).toContain('go-modules.drv');
  }, 600_000);

  it('zig: uses a real fetcher, and the pin moves the derivation', async () => {
    // also guards the fetcher API itself: the old expression referenced
    // pkgs/build-support/zig/fetch-deps.nix, which no longer exists
    const zig = await findNonDefault('zig', 'zig');
    expect(zig).not.toBeNull();
    const ok = await evalDrv(
      exprForZigDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'zig', version: zig!.version }] },
        'sha256',
      ),
    );
    expect(ok.err).toBe('');
    expect(ok.out).toContain('zig-deps.drv');
    const plain = await evalDrv(exprForZigDeps(FLAKE, VEND, 'sha256'));
    expect(ok.out).not.toBe(plain.out);
  }, 600_000);

  it('zig: aborts rather than falling back to a different compiler', async () => {
    const gone = await evalDrv(
      exprForZigDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'zig', version: '0.3.0' }] },
        'sha256',
      ),
    );
    // refusing is the point: the default compiler would fetch a different tree
    expect(gone.ok).toBe(false);
    expect(gone.err).toContain('nix-update:');
  }, 600_000);

  it('composer: both builder generations expose the attribute they are read for', async () => {
    const v2 = await evalDrv(
      exprForComposerVendor(FLAKE, VEND, 'sha256', 'composerVendor'),
    );
    expect(v2.err).toBe('');
    const v1 = await evalDrv(
      exprForComposerVendor(FLAKE, VEND, 'sha256', 'composerRepository'),
    );
    expect(v1.err).toBe('');
  }, 600_000);

  it('mix: an elixir the runner cannot pair with its erlang aborts cleanly', async () => {
    const r = await evalDrv(
      exprForMixFodDeps(
        FLAKE,
        { ...VEND, tools: [{ pname: 'elixir', version: '1.17.3' }] },
        'sha256',
      ),
    );
    // the incompatibility surfaces while forcing the guard, so without tryEval
    // this is an erlang/elixir assertion instead of our own message
    expect(r.ok).toBe(false);
    expect(r.err).toContain('nix-update:');
  }, 600_000);
});
