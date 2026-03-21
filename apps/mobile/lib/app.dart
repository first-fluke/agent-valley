import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import 'router/router.dart';
import 'theme/app_theme.dart';
import 'theme/theme_provider.dart';

class MappleApp extends ConsumerWidget {
  const MappleApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    final themeMode = ref.watch(themeModeNotifierProvider);

    return FTheme(
      data: themeMode == ThemeMode.dark
          ? FThemes.zinc.dark
          : FThemes.zinc.light,
      child: MaterialApp.router(
        title: 'Mapple',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        routerConfig: router,
      ),
    );
  }
}
