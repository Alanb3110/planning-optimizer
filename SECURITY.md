# Data-handling policy

This repository is public. Do not commit operational project data, generated schedules, organization-specific identifiers, credentials, or local configuration.

Use input and output directories outside the repository. Before proposing a public commit, run:

```bash
python scripts/check_public_data.py --root .
```

For organization-specific terms, maintain a private denylist outside the clone and pass it with `--denylist`.

If sensitive data is committed, assume it has been copied. Revoke affected credentials when applicable, remove the material from the current tree, and rewrite repository history before further publication.
