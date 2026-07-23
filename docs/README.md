# Documentation

This directory is the GitHub Pages documentation site for the Jump Host project.

**Live site:** https://theta42.github.io/jump-host/

## Pages

- `index.md` — overview and quick start
- `connecting.md` — usage: the username grammar, the TUI picker, SFTP/WinSCP
- `architecture.md` — how auth, access resolution, key injection, and bridging work
- `installation.md` — Docker, bare-metal, and theta-env install; the LDAP write-ACL

## Local preview

```bash
gem install jekyll bundler
cd docs && jekyll serve
# http://localhost:4000/jump-host/
```

## Updating

Edit the markdown, push to `master`, and GitHub Pages rebuilds automatically.
