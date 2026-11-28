# Object Category System and Timeline Rendering

## Goals
- Structure all objects (events, relationships, tasks, notes, etc.) via assignable categories.
- Provide visual differentiation on the timeline based on category styles.
- Support nested categories, priorities, and multiple category memberships per object.
- Allow configuration of category appearance (color, opacity, icon/background) and ordering.

## Core Concepts
- **Category** — a node in the category tree. Can have one parent and many children.
- **Priority** — integer indicating importance. Higher value = higher priority.
- **Order** — sort order among siblings (fallback when priorities are equal).
- **Category assignment** — reference from an object to one or more categories.

## Data Model
### `categories` collection
```
{
  _id: ObjectId,
  name: string,                  // UI name
  slug: string,                  // Stable identifier/key
  description?: string,
  parentId?: ObjectId,           // Reference to parent category
  path: string[],                // Cached path from root (array of _id/slug) for quick lookups
  priority: number,              // Higher = more important
  order: number,                 // Order within the same parent
  isDefault: boolean,            // Use by default for new objects of a given type
  display: {
    color: string,               // HEX or rgba
    backgroundColor?: string,    // HEX or rgba for fill/badge
    opacity: number,             // 0..1
    icon?: { text?: string, url?: string },
    pattern?: string,            // e.g., hatching when combined
    timelineHeight?: number,     // Lane/card height (px)
    labelVisibility?: 'always' | 'hover' | 'hidden'
  },
  meta?: {
    createdBy: string,
    createdAt: ISODate,
    updatedAt: ISODate
  }
}
```

### Category references in objects (`objects`)
- New field `categories: ObjectId[]` (or `slug[]` in exports).
- An object can have 0..N categories.
- Index `objects.categories` for fast timeline filtering.

### Inheritance rules
- If a category lacks `display`, the UI resolves values from the parent, walking `path` up to the root.
- Default priority inherits from the parent but can be overridden.
- Order is only meaningful among siblings; when mixed, sort by priority, then by `order`.

## Operations
### Category CRUD
- **Create/Update**: validate global uniqueness of `slug` and sibling-level uniqueness of `name`.
- **Delete**: delete operation should be forbidden when the category has children or is assigned to objects (require reassignment/rename/archive first).
- **Move**: change `parentId` and recompute `path` for all descendants.

### Assigning categories to objects
- Update `objects.categories` during object create/edit.
- Limit assignment count (configurable, e.g., ≤10) for UX control.
- APIs should return both identifiers and expanded category data for the frontend.

### Preset categories
- Base set (example): `work`, `relationships`, `health`, `finance`, `learning`, `personal`.
- Nested examples: `work/performance-improvement-plan`, `work/freelance`, `work/full-time`; `relationships/friends`, `relationships/family`, `relationships/romantic`.
- Migration creates root and nested categories with default `priority`, `order`, and `display`.

## Timeline Rendering
### Leading category selection
1. If an object has a single category — use its `display`.
2. If multiple categories:
   - Sort the object's categories by `priority` (desc), then by `path` depth (more specific first), then by `order`.
   - Take the first as the **leading** category for primary color/background.
   - Optionally render secondary categories as icons/patterns/badges.
3. For overlapping objects on the timeline, use category priority to resolve stacking (higher = above).

### Visual elements
- **Color stripe/background** on the card uses `display.backgroundColor` with `opacity`.
- **Icon/emoji** at the left or corner uses `display.icon`.
- **Category label** follows `labelVisibility` (always/hover/hidden).
- **Lane height** (`timelineHeight`) controls line/card thickness.
- On hover, show breadcrumb `parent → child` for context.

### Filtering and grouping
- Filter by multiple categories: `objects.categories` IN selected; optional modes "all selected" (AND) or "any" (OR).
- Group by root categories with fold/unfold to show/hide branches.
- Display breadcrumbs (`root / ... / leaf`) on the card or tooltip.

## API/Contracts (proposal)
- `GET /categories`: returns the category tree with inherited `display` applied (server may add `resolvedDisplay`).
- `POST /categories`: create a category.
- `PATCH /categories/:id`: update category parent, `display`, `priority`, `order`.
- `DELETE /categories/:id`: delete/archive with validations.
- `POST /objects/:id/categories`: replace/patch the object's category list.
- Object responses include `categoriesDetailed: Category[]` with path info and `resolvedDisplay`.

## Backend Implementation Details
- Storage: MongoDB (aligned with `objects`).
- Indexes:
  - `categories.slug` (unique).
  - `categories.parentId + order` (sibling sorting).
  - `categories.priority` (timeline/queries).
  - `objects.categories` (multikey for filters).
- Trigger/server hook on category change recomputes `path` for descendants.
- Inheritance resolution for `display` can be cached in `resolvedDisplay` and refreshed on parent change.

## Frontend Implementation Details
- State manager stores the category tree and a map `id → resolvedDisplay`.
- Category editor form: name, color, opacity, icon, priority, order, parent.
- Object category picker: search/autocomplete, path display, color hint.
- Timeline component:
  - Sorts objects by leading category (priority → depth → order) when overlapping.
  - Renders color fills/patterns and icons.
  - Supports filters (AND/OR) and quick presets (e.g., "Work", "Relationships").

## Migration and Backward Compatibility
1. Create the `categories` collection and indexes.
2. Seed preset categories with baseline styles.
3. Add field `categories: []` to all existing objects (mass update).
4. (Optional) Auto-classify legacy objects by type (`isRelationship`, `isEvent`, `isTask`) and context, but allow manual correction.
5. Update object API responses to include `categoriesDetailed`.

## Default Priorities (example)
- Root types:
  - `relationships`: priority 90
  - `work`: priority 80
  - `health`: priority 70
  - `finance`: priority 60
  - `learning`: priority 50
  - `personal`: priority 40
- Within `work` (order and optional priority offset):
  - `pip` (Performance Improvement Plan): priority 85, order 10
  - `full-time`: priority 82, order 20
  - `freelance`: priority 81, order 30
- Child priority may slightly decrease relative to parent, but explicit values always override inheritance.

## UX Policies
- Limit simultaneously selected filters (e.g., ≤8) and show a counter.
- In the object editor, show tooltip with category color/icon and path.
- If an object has no category, display a neutral style and prompt "Add a category to filter on the timeline.".

## Observability and Data Quality
- Log the number of objects without categories and without a leading category — quality metric.
- Track priority distribution to avoid excessive duplicates that harm sorting.
- In admin UI, flag conflicts (two categories with the same priority/order) and suggest fixes.

## Risks and Limitations
- Deep trees may require UI pagination/virtualization; cap depth (e.g., 5 levels) or use lazy loading.
- With multi-category objects, clearly explain which category became the leading one and why (priority → depth → order).
- Moving/deleting a category can break styling; prefer archiving and mass reassignment.
