// 桌面上的应用清单。
//
// 加一个应用 = 往这里加一条。桌面和容器都不用动。
//
// 「开发者模式」这个应用只在开发者模式打开时出现 —— 关掉就该干干净净，
// 桌面上不该留一个点进去是空的图标。

import 'package:flutter/material.dart';

import 'about_app.dart';
import 'conversations_app.dart';
import 'dev_mode_app.dart';
import 'mini_app.dart';

/// 当前该摆在桌面上的应用。
List<MiniApp> availableMiniApps(MiniAppEnv env) {
  final apps = <MiniApp>[
    if (env.transport != null)
      MiniApp(
        id: 'conversations',
        name: '会话',
        icon: Icons.forum_outlined,
        color: const Color(0xFF4A90D9),
        description: '所有会话与设置',
        build: (context) => ConversationsAppPage(transport: env.transport!),
      ),
    MiniApp(
      id: 'about',
      name: '关于',
      icon: Icons.info_outline,
      color: const Color(0xFF7A8AA0),
      description: '版本与连接状态',
      build: (context) => AboutAppPage(controller: env.controller),
    ),
    // 开发者模式：只在开着的时候出现。
    if (env.devMode)
      MiniApp(
        id: 'dev',
        name: '开发者模式',
        icon: Icons.terminal,
        color: const Color(0xFFD29922),
        description: '后台正在做什么',
        closeTooltip: '关闭开发者模式',
        build: (context) => DevModeAppPage(controller: env.controller),
      ),
  ];
  return apps;
}
