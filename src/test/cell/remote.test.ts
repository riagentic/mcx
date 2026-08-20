// The remote filesystem, end to end, against a stand-in for ssh.
//
// There is no network here and no sshd, and that is fine: what mcx actually
// owns is the COMMAND it builds and the OUTPUT it parses. A stub `ssh` on PATH
// exercises both — the real thing would only be testing OpenSSH.
import { bootCells } from "aio/testing";
import { assert, assertEquals } from "@std/assert";
import { panels } from "../../cell/panels.ts";
import { ops } from "../../cell/ops.ts";
import { ui } from "../../cell/ui.ts";

const LISTING = `total 12
drwxr-xr-x 2 alice devs  4096 2026-08-14 09:12 subdir
-rw-r--r-- 1 alice devs   137 2026-01-02 23:04 notes.txt
lrwxrwxrwx 1 alice devs     7 2026-08-14 09:12 link -> ../target
-rwxr-xr-x 1 root  root  1234 2025-12-31 08:00 run.sh`;

/** A directory holding fake `ssh` and `scp`, first on PATH. Each records what
 *  it was asked to do, so the test can assert on the command line mcx built. */
async function withFakeSsh(
  fn: (log: () => Promise<string>, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mcx-ssh-" });
  const logFile = `${dir}/calls.log`;
  await Deno.writeTextFile(
    `${dir}/ssh`,
    `#!/bin/sh
echo "ssh $*" >> ${logFile}
# The last argument is the command; answer the two mcx sends.
last=\$(eval echo \\\${$#})
case "$last" in
  pwd) echo /home/alice ;;
  *"ls -la"*) cat <<'EOF2'
${LISTING}
EOF2
  ;;
  *) exit 0 ;;
esac
`,
  );
  await Deno.writeTextFile(
    `${dir}/scp`,
    `#!/bin/sh
echo "scp $*" >> ${logFile}
# The last two arguments are source and destination; a remote one has a colon.
src=\$(eval echo \\\${$(($#-1))})
dst=\$(eval echo \\\${$#})
case "$src" in *:*) printf 'fetched contents\\n' > "$dst" ;; *) cp -r "$src" "\${dst#*:}" 2>/dev/null || true ;; esac
`,
  );
  await Deno.chmod(`${dir}/ssh`, 0o755);
  await Deno.chmod(`${dir}/scp`, 0o755);

  const oldPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${oldPath}`);
  const h = await bootCells([ui, panels, ops]);
  try {
    await fn(
      async () => {
        try {
          return await Deno.readTextFile(logFile);
        } catch {
          return "";
        }
      },
      dir,
    );
  } finally {
    h.dispose();
    Deno.env.set("PATH", oldPath);
  }
}

const names = () => panels.left.rows.map((r) => r.name);

Deno.test("a remote directory lists like a local one", () =>
  withFakeSsh(async (log) => {
    await panels.chdir("left", "sh://alice@testhost/var/log");
    assertEquals(panels.left.path, "sh://alice@testhost/var/log");
    // `..` first, then the entries SORTED — directories first, then by name.
    // The remote listing goes through the same arrangement a local one does,
    // which is the point: everything downstream is unchanged.
    assertEquals(names(), ["..", "subdir", "link", "notes.txt", "run.sh"]);

    const calls = await log();
    assert(calls.includes("alice@testhost"), calls);
    assert(calls.includes("ls -la --time-style=long-iso"), calls);
    // The path is quoted: a remote directory with a space in it is not two
    // arguments.
    assert(calls.includes("/var/log"), calls);
  }));

Deno.test("a bare host asks the far side where home is", () =>
  withFakeSsh(async (log) => {
    await panels.chdir("left", "sh://testhost");
    assertEquals(panels.left.path, "sh://testhost/home/alice");
    assert((await log()).includes("pwd"), await log());
  }));

Deno.test("Enter walks into a remote directory and .. walks back out", () =>
  withFakeSsh(async () => {
    await panels.chdir("left", "sh://testhost/var/log");
    await panels.setCursor(names().indexOf("subdir"));
    await panels.enter();
    assertEquals(panels.left.path, "sh://testhost/var/log/subdir");
    await panels.chdir("left", "..");
    assertEquals(panels.left.path, "sh://testhost/var/log");
  }));

Deno.test("leaving the top of a remote tree comes home rather than nowhere", () =>
  withFakeSsh(async () => {
    await panels.chdir("left", "sh://testhost/");
    await panels.chdir("left", "..");
    assert(!panels.left.path.startsWith("sh://"), panels.left.path);
  }));

Deno.test("a remote file is fetched before anything opens it", () =>
  withFakeSsh(async (log) => {
    await panels.chdir("left", "sh://testhost/var/log");
    await panels.setCursor(names().indexOf("notes.txt"));
    const local = await panels.fetchCurrent();
    assert(local, "nothing was fetched");
    assertEquals(await Deno.readTextFile(local!), "fetched contents\n");
    const calls = await log();
    assert(calls.includes("scp"), calls);
    assert(calls.includes("testhost:/var/log/notes.txt"), calls);
  }));

Deno.test("F7 on a remote panel makes the directory on the far side", () =>
  withFakeSsh(async (log) => {
    await panels.chdir("left", "sh://testhost/var/log");
    await ops.mkdir("new dir");
    const calls = await log();
    assert(calls.includes("mkdir -p"), calls);
    // Quoted, so a name with a space in it is one directory.
    assert(calls.includes("'/var/log/new dir'"), calls);
  }));

Deno.test("the selection of a remote panel is remote URLs", () =>
  withFakeSsh(async () => {
    await panels.chdir("left", "sh://testhost/var/log");
    await panels.setCursor(names().indexOf("run.sh"));
    assertEquals(await panels.selection(), ["sh://testhost/var/log/run.sh"]);
  }));

Deno.test("a remote listing that fails says so instead of showing nothing", () =>
  withFakeSsh(async (_log, dir) => {
    // An ssh that refuses everything, the way an unreachable host does.
    await Deno.writeTextFile(
      `${dir}/ssh`,
      "#!/bin/sh\necho 'ssh: connect to host testhost port 22: Connection refused' >&2\nexit 255\n",
    );
    await Deno.chmod(`${dir}/ssh`, 0o755);
    await panels.chdir("left", "sh://testhost/var/log");
    assert(panels.left.error, "no error reported");
    assert(
      panels.left.error!.includes("Connection refused"),
      panels.left.error!,
    );
  }));
