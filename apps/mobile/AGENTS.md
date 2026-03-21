# AGENTS.md — Mapple Mobile (Flutter)

> Agent entry point for the Flutter mobile application.

---

## 1. Install & Build

```bash
# Install dependencies
cd apps/mobile && flutter pub get

# Generate code (Riverpod providers, Drift tables)
dart run build_runner build --delete-conflicting-outputs

# Run on connected device
flutter run

# Run tests
flutter test
```

**Required:** Flutter SDK >= 3.27.0, Dart SDK >= 3.6.0

---

## 2. Architecture

**Feature-first structure:**

```
lib/
├── main.dart              ← Entry point
├── app.dart               ← MaterialApp + FTheme + router
├── router/
│   ├── router.dart        ← GoRouter with StatefulShellRoute (4-tab)
│   └── shell_scaffold.dart ← Bottom NavigationBar shell
├── theme/
│   ├── app_theme.dart     ← Light/dark ThemeData
│   └── theme_provider.dart ← ThemeMode state (Riverpod)
└── features/
    ├── globe/             ← Globe tab
    ├── graph/             ← Graph tab
    ├── contacts/          ← Contacts tab
    └── settings/          ← Settings tab (includes theme toggle)
```

**State management:** Riverpod 3 with code generation (`@riverpod` annotations).

**Routing:** go_router with `StatefulShellRoute.indexedStack` for bottom navigation.

**UI framework:** Forui (zinc theme) wrapping Material 3.

**Networking:** Dio for HTTP, Drift for local DB.

---

## 3. Conventions

- Use `@riverpod` annotation for all providers (code gen required)
- Feature screens extend `ConsumerWidget` or `ConsumerStatefulWidget`
- Place providers in `providers/` subdirectory within each feature
- Validate external inputs at the boundary only
- Run `dart run build_runner build` after adding/modifying providers

---

## 4. Key Dependencies

| Package | Purpose |
|---|---|
| `flutter_riverpod` | State management |
| `riverpod_annotation` | Provider code generation |
| `go_router` | Declarative routing |
| `forui` | UI component library |
| `dio` | HTTP client |
| `drift` | Local SQLite database |
| `flutter_inappwebview` | In-app browser |
| `connectivity_plus` | Network connectivity detection |
