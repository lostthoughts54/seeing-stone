# Asset provenance

All release assets must have an identified source and redistribution basis.

| Asset | Source | License/status |
| --- | --- | --- |
| `build/icon.svg` | Original repository-native SVG created for Seeing Stone | GPL-2.0-or-later with the application |
| `src/renderer/assets/seeing-stone-orb.svg` | Repository-native copy of the original Seeing Stone orb geometry | GPL-2.0-or-later with the application |
| `src/renderer/assets/fonts/InterVariable.woff2` | Inter 4.1, upstream tag `v4.1`, commit `e3a3d4c57d5ecc01453a575621882a384c1995a3` | OFL-1.1; SHA-256 `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| `src/renderer/assets/fonts/Spectral-Regular.ttf` | Google Fonts snapshot `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` | OFL-1.1; SHA-256 `c89021dc20720c8d0dcf40b0b2f6e00c13665fa8041717f581396f51b8c78f5d` |
| `src/renderer/assets/fonts/Spectral-SemiBold.ttf` | Google Fonts snapshot `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` | OFL-1.1; SHA-256 `5f86915a744832ecf6e4a17ab04bea091b9fa992ef5164ff65ae34c1da2fe94b` |
| Inter and Spectral license texts | Family-specific upstream OFL notices beside the font assets | OFL-1.1; hashes recorded in `legal-components.json` |
| Runtime test media under `.runtime/` | Local acceptance fixtures; excluded from Git and release packages | Not distributed |
| Approved UI mockup | User-provided visual direction | Reference only; not packaged |

No Tolkien-specific artwork, scripts, marks, maps, film imagery, quotations, or
prop replicas are included. Future fonts and imagery must be added to this table,
`legal-components.json`, and the generated notices before packaging.
