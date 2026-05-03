---
name: image-manipulation-image-magick
description: Process and manipulate images using ImageMagick. Supports resizing, format conversion (including DDS for Paradox games), batch processing, and retrieving image metadata. Use when working with images, creating thumbnails, resizing assets, or converting to game-ready formats.
compatibility: Requires ImageMagick installed and available as `magick` on PATH.
---

# Image Manipulation with ImageMagick

This skill enables image processing and manipulation tasks using ImageMagick.

**CRITICAL**: All commands below use `cmd.exe` syntax (the shell used by `run_command`).
Do NOT use PowerShell syntax (`& $magick`, `Get-ChildItem`, `ForEach-Object`).

## When to Use This Skill

Use this skill when you need to:

- Resize images to exact dimensions
- Convert between image formats (PNG, JPG, DDS, TGA, WebP)
- Convert to DDS format for Paradox game engines (Stellaris, EU4, CK3, etc.)
- Get image dimensions and metadata
- Create thumbnails
- Batch process multiple images

## Prerequisites

- ImageMagick installed and `magick` available on PATH
- Verify: `magick --version`

## Core Commands (cmd.exe syntax)

### 1. Get Image Dimensions

```
magick identify -format "%wx%h" "path/to/image.png"
```

Output: `1024x768`

### 2. Get Detailed Image Info

```
magick identify -verbose "path/to/image.png"
```

### 3. Resize Image (Force Exact Dimensions)

```
magick convert "input.png" -resize 128x128! "output.png"
```

**IMPORTANT**: The `!` suffix forces EXACT dimensions (ignores aspect ratio).
Without `!`, ImageMagick preserves aspect ratio and fits within the bounding box.

### 4. Convert Between Formats

```
magick convert "input.png" "output.jpg"
magick convert "input.jpg" "output.png"
magick convert "input.tga" "output.png"
```

### 5. DDS Conversion (Paradox Game Engine)

**DXT5 compression** (use when both width AND height are multiples of 4):
```
magick convert "input.png" -define dds:compression=dxt5 "output.dds"
```

**DXT1 compression** (no alpha channel, smaller file, both dimensions must be multiples of 4):
```
magick convert "input.png" -define dds:compression=dxt1 "output.dds"
```

**Uncompressed ARGB** (use when dimensions are NOT multiples of 4):
```
magick convert "input.png" "output.dds"
```

### 6. Resize + DDS Conversion (Common Stellaris Workflow)

```
magick convert "input.jpg" -resize 156x210! -define dds:compression=dxt5 "output.dds"
```

### 7. Create Thumbnail

```
magick convert "input.png" -resize 427x240 "thumbnail.png"
```

### 8. Batch Resize (cmd.exe loop)

```
for %f in ("input_dir\*.png") do magick convert "%f" -resize 128x128! "output_dir\%~nf.png"
```

### 9. Batch Convert to DDS (cmd.exe loop)

```
for %f in ("input_dir\*.png") do magick convert "%f" -define dds:compression=dxt5 "output_dir\%~nf.dds"
```

## Stellaris-Specific Dimension Reference

| Asset Type | Dimensions | Notes |
|-----------|-----------|-------|
| Event picture | 480x300 | `gfx/event_pictures/` |
| Leader portrait | 156x210 | `gfx/models/portraits/` |
| Species portrait | 128x128 | Thumbnail for species selection |
| Technology icon | 68x68 | `gfx/interface/icons/technologies/` |
| Building icon | 68x68 | `gfx/interface/icons/buildings/` |
| Resource icon | 30x30 | `gfx/interface/icons/resources/` |
| Flag emblem | 128x128 | `gfx/flags/` |
| Loading screen | 1920x1200 | `gfx/loadingscreens/` |

## Guidelines

1. **Always quote file paths** — paths may contain spaces
2. **Use forward slashes** — `magick convert "C:/path/to/file.png"` works in cmd.exe and avoids escaping issues
3. **Use `!` for exact resize** — without it, aspect ratio is preserved
4. **Check dimensions before DDS** — DXT compression requires dimensions that are multiples of 4
5. **Verify output** — use `magick identify` after conversion to confirm dimensions and format

## Limitations

- Large batch operations may be memory-intensive
- DXT compression requires dimensions that are multiples of 4 (use uncompressed for odd sizes)
- ImageMagick 7.x uses `magick convert`; older 6.x uses just `convert`
