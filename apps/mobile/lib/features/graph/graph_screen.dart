import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class GraphScreen extends ConsumerWidget {
  const GraphScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Graph')),
      body: const Center(
        child: Icon(Icons.show_chart, size: 96, color: Colors.grey),
      ),
    );
  }
}
