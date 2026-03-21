import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class GlobeScreen extends ConsumerWidget {
  const GlobeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Globe')),
      body: const Center(
        child: Icon(Icons.public, size: 96, color: Colors.grey),
      ),
    );
  }
}
