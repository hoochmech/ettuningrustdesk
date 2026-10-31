import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_hbb/common.dart';
import 'package:flutter_hbb/models/model.dart';
import 'package:flutter_hbb/models/platform_model.dart';

// USB over IP (src/usbip.rs): use a USB device plugged into the customer's PC, such as
// an RP1210 adapter, as if it were plugged into this one.
void showUsbDevicesDialog(FFI ffi, String id) {
  ffi.dialogManager.show((setState, close, context) {
    return CustomAlertDialog(
      title: Text('USB devices'),
      content: _UsbDevices(ffi: ffi, id: id),
      actions: [dialogButton('Close', onPressed: close)],
      onCancel: close,
    );
  });
}

class _UsbDevices extends StatefulWidget {
  final FFI ffi;
  final String id;
  const _UsbDevices({required this.ffi, required this.id});

  @override
  State<_UsbDevices> createState() => _UsbDevicesState();
}

class _UsbDevicesState extends State<_UsbDevices> {
  Timer? _timer;
  Map<String, dynamic> _state = {};

  bool get _supported =>
      widget.ffi.ffiModel.pi.platformAdditions['et_usbip'] == true;

  @override
  void initState() {
    super.initState();
    if (_supported) {
      _request('list');
      _poll();
      _timer = Timer.periodic(Duration(seconds: 1), (_) => _poll());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _poll() {
    try {
      final s = jsonDecode(bind.mainEtUsbState(peerId: widget.id));
      if (mounted && s is Map<String, dynamic>) setState(() => _state = s);
    } catch (e) {
      debugPrint('USB state: $e');
    }
  }

  void _request(String action, [String busId = '']) {
    bind.sessionEtUsbRequest(
        sessionId: widget.ffi.sessionId, action: action, busId: busId);
  }

  Future<void> _use(String busId) async {
    await bind.mainEtUsbAttach(peerId: widget.id, busId: busId);
    _request('share', busId);
    if (!mounted) return;
    final connToken = bind.sessionGetConnToken(sessionId: widget.ffi.sessionId);
    connect(context, widget.id, isTcpTunneling: true, connToken: connToken);
  }

  @override
  Widget build(BuildContext context) {
    if (!_supported) {
      return SizedBox(
        width: 420,
        child: Text(
            "The remote PC's client can't share USB devices. Update it to the latest ET Tuning Remote Client."),
      );
    }
    final devices = (_state['devices'] as List?) ?? [];
    final error = (_state['error'] as String?) ?? '';
    final status = (_state['status'] as String?) ?? '';
    return SizedBox(
      width: 520,
      child: SingleChildScrollView(
          child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
              "Devices plugged into the remote PC. \"Use here\" shares one and attaches it to this PC through a TCP tunnel."),
          SizedBox(height: 12),
          if (devices.isEmpty && error.isEmpty)
            Text(_state.isEmpty ? 'Loading...' : 'No USB devices found.'),
          ...devices.map((d) {
            final busId = d['bus_id'] as String? ?? '';
            final shared = d['shared'] == true;
            final attached = d['attached'] == true;
            return ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(d['description'] as String? ?? busId),
              subtitle: Text(
                  '$busId · ${attached ? 'In use' : shared ? 'Shared' : 'Not shared'}'),
              trailing: shared
                  ? TextButton(
                      onPressed: () => _request('unshare', busId),
                      child: Text('Stop'))
                  : ElevatedButton(
                      onPressed: () => _use(busId), child: Text('Use here')),
            );
          }),
          if (error.isNotEmpty) ...[
            SizedBox(height: 8),
            SelectableText(error, style: TextStyle(color: Colors.red)),
          ],
          if (status.isNotEmpty) ...[
            SizedBox(height: 8),
            SelectableText(status),
          ],
          SizedBox(height: 8),
          TextButton.icon(
              onPressed: () => _request('list'),
              icon: Icon(Icons.refresh, size: 16),
              label: Text('Refresh')),
        ],
      )),
    );
  }
}
