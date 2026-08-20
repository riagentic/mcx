import { assertEquals } from "@std/assert";
import {
  basename,
  dirname,
  entryPath,
  extname,
  join,
  normalize,
  parent,
  relativeTo,
  resolve,
  tildify,
} from "../../lib/path.ts";

Deno.test("dirname walks up and stops at the root", () => {
  assertEquals(dirname("/a/b/c"), "/a/b");
  assertEquals(dirname("/a"), "/");
  assertEquals(dirname("/"), "/");
  assertEquals(dirname("/a/b/"), "/a");
});

Deno.test("basename is the last segment", () => {
  assertEquals(basename("/a/b/c"), "c");
  assertEquals(basename("/a/b/"), "b");
  assertEquals(basename("/"), "/");
});

Deno.test("extname ignores dotfiles", () => {
  assertEquals(extname("a.tar.gz"), "gz");
  assertEquals(extname(".bashrc"), "");
  assertEquals(extname("noext"), "");
});

Deno.test("normalize resolves . and ..", () => {
  assertEquals(normalize("/a/b/../c"), "/a/c");
  assertEquals(normalize("/a/./b//c"), "/a/b/c");
  assertEquals(normalize("/../.."), "/");
  assertEquals(normalize("a/../../b"), "../b");
});

Deno.test("join normalizes as it goes", () => {
  assertEquals(join("/a", "b", "c"), "/a/b/c");
  assertEquals(join("/a/b", ".."), "/a");
});

Deno.test("resolve handles absolute, relative and ~", () => {
  assertEquals(resolve("/a/b", "/x"), "/x");
  assertEquals(resolve("/a/b", "c"), "/a/b/c");
  assertEquals(resolve("/a/b", "../c"), "/a/c");
  assertEquals(resolve("/a/b", "~/d", "/home/u"), "/home/u/d");
  assertEquals(resolve("/a/b", "~", "/home/u"), "/home/u");
});

Deno.test("entryPath keeps an absolute row name absolute", () => {
  // Panelized rows (find → panelize) name themselves by absolute path, and the
  // panel's `path` is a label rather than a directory.
  assertEquals(entryPath("/a/b", "c.txt"), "/a/b/c.txt");
  assertEquals(entryPath("find:*.txt", "/a/b/c.txt"), "/a/b/c.txt");
  assertEquals(entryPath("/a", "/x/./y"), "/x/y");
});

Deno.test("parent is null only at the root", () => {
  assertEquals(parent("/a/b"), "/a");
  assertEquals(parent("/"), null);
});

Deno.test("tildify shortens only true prefixes", () => {
  assertEquals(tildify("/home/u/p", "/home/u"), "~/p");
  assertEquals(tildify("/home/u", "/home/u"), "~");
  assertEquals(tildify("/home/user2/p", "/home/u"), "/home/user2/p");
});

Deno.test("relativeTo writes one path as seen from another", () => {
  assertEquals(relativeTo("/a/x", "/a/b/c"), "../b/c");
  assertEquals(relativeTo("/a/b", "/a/b/c"), "c");
  assertEquals(relativeTo("/a/b/c", "/a"), "../..");
  assertEquals(relativeTo("/a", "/a"), ".");
  assertEquals(relativeTo("/", "/etc/hosts"), "etc/hosts");
  // The point of C-x v: the pair survives being moved together.
  assertEquals(
    relativeTo("/srv/site", "/srv/site/assets/logo.svg"),
    "assets/logo.svg",
  );
});
