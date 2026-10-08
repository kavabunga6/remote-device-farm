import { t } from './i18n';
export type ConsoleCommandAccess = 'console' | 'upload' | 'external';
export type ConsoleCommandCategory = 'adb' | 'device' | 'packages' | 'activity' | 'settings' | 'diagnostics' | 'input' | 'files' | 'network' | 'services' | 'transfer';

export interface ConsoleCommandHint {
  command: string;
  label: string;
  description: string;
  category: ConsoleCommandCategory;
  access: ConsoleCommandAccess;
  action?: 'upload-apk' | 'upload-file';
  syntax: string;
  arguments: string;
  example: string;
  keywords: string;
  caution?: string;
  dynamic?: boolean;
}

export const CONSOLE_CATEGORIES: Array<{ id: ConsoleCommandCategory; label: string }> = [
  { id: 'adb', get label() { return t('ui.cf53269e72da'); } },
  { id: 'device', get label() { return t('ui.ec571e827205'); } },
  { id: 'packages', get label() { return t('ui.1852c93ae601'); } },
  { id: 'activity', get label() { return t('ui.494412727c62'); } },
  { id: 'settings', get label() { return t('ui.985b5e0f2ccf'); } },
  { id: 'diagnostics', get label() { return t('ui.da4da4e3527c'); } },
  { id: 'input', get label() { return t('ui.8d7cd64f0372'); } },
  { id: 'files', get label() { return t('ui.deb283fa2c11'); } },
  { id: 'network', get label() { return t('ui.76fe0eecb6ff'); } },
  { id: 'services', get label() { return t('ui.f9f1a2dc9e05'); } },
  { id: 'transfer', get label() { return t('ui.68eae1b96020'); } },
];

function c(category: ConsoleCommandCategory, command: string, label: string, description: string, args: string, example: string, keywords: string, caution?: string): ConsoleCommandHint {
  return { category, command, label, description, access: 'console', syntax: command, arguments: args, example, keywords, caution };
}

function other(access: 'upload' | 'external', command: string, label: string, description: string, args: string, example: string, keywords: string): ConsoleCommandHint {
  return { category: 'transfer', command, label, description, access, action: access === 'upload' ? command.startsWith('install ') ? 'upload-apk' : 'upload-file' : undefined, syntax: command, arguments: args, example, keywords };
}

// Only the fixed, session-scoped ADB verbs below are top-level commands.
// All other console entries are Android shell commands on the selected device.
// Examples and templates deliberately omit the local "adb" prefix.
export function getConsoleCommands(): ConsoleCommandHint[] { return [
  c('adb', 'devices', t('ui.490b7b20efb6'), t('ui.4fa71c5b6cf7'), t('ui.b4b8fed72cac'), 'devices', t('ui.69411459b826')),
  c('adb', 'get-state', t('ui.e9e8fae59979'), t('ui.74d02b0adb17'), t('ui.b4b8fed72cac'), 'get-state', t('ui.bfbff1ff6589')),
  c('adb', 'get-serialno', t('ui.bb134e993025'), t('ui.d464c243672a'), t('ui.b4b8fed72cac'), 'get-serialno', t('ui.02b4048fd279')),
  c('adb', 'version', t('ui.b7eab015cd04'), t('ui.9dbae1030f14'), t('ui.b4b8fed72cac'), 'version', t('ui.34c155af74d2')),
  c('adb', t('ui.e3015b0654bb'), t('ui.fca3d4db38cd'), t('ui.4e8f02b5ecfb'), t('ui.4c6c01b9662d'), 'shell getprop ro.product.model', t('ui.c51532e8993b')),
  c('adb', 'reboot', t('ui.34569a1676b0'), t('ui.7a0e49efc992'), t('ui.b4b8fed72cac'), 'reboot', t('ui.f13eb1567b68'), t('ui.da2b25334f7a')),
  c('adb', t('ui.00cdbc212969'), t('ui.619eef1d39ff'), t('ui.a3b0d74cb554'), t('ui.e6fdae9dc905'), 'uninstall com.example.app', t('ui.aaa07f4b743b'), t('ui.fb9a55b3df2f')),
  c('adb', 'logcat -d -t 200', t('ui.0c340d56569c'), t('ui.73181bed4082'), t('ui.1dd66ebf0205'), 'logcat -d -t 200', t('ui.bf77863fda18')),
  c('adb', 'logcat -d -b crash -t 200', t('ui.727adfc2dd6f'), t('ui.ee709e6463ee'), t('ui.15c20097fbef'), 'logcat -d -b crash -t 200', t('ui.b65c9e42b808')),
  c('adb', 'logcat -d -v threadtime -t 200', t('ui.8ebf8efed139'), t('ui.9f147060b83b'), t('ui.de370bb2f66f'), 'logcat -d -v threadtime -t 200', t('ui.64fb4ae5e2e6')),

  c('device', 'getprop ro.build.version.release', t('ui.7b1487ed07ac'), t('ui.d42345a5de30'), t('ui.6d219da954ed'), 'getprop ro.build.version.release', t('ui.bb1835dfb8c3')),
  c('device', 'getprop ro.build.version.sdk', t('ui.0087a84e0b83'), t('ui.adf5600d5539'), t('ui.6d219da954ed'), 'getprop ro.build.version.sdk', t('ui.e10ecab74eb4')),
  c('device', 'getprop ro.product.model', t('ui.805268e3ed0d'), t('ui.140aac8eacda'), t('ui.6d219da954ed'), 'getprop ro.product.model', t('ui.0a43b4e1d99a')),
  c('device', 'getprop ro.build.fingerprint', t('ui.fd994b8e3d57'), t('ui.39bb63beb844'), t('ui.6d219da954ed'), 'getprop ro.build.fingerprint', t('ui.3896c1803a73')),
  c('device', 'getprop', t('ui.c4804d262837'), t('ui.7ab7e751ffc6'), t('ui.b4b8fed72cac'), 'getprop', t('ui.2273a7bc0c1e')),
  c('device', 'uname -a', t('ui.be73c9222389'), t('ui.6596327c108a'), t('ui.6f97ea353779'), 'uname -a', t('ui.75bdd403b056')),
  c('device', 'uptime', t('ui.54c9f868ae3d'), t('ui.983188a17571'), t('ui.b4b8fed72cac'), 'uptime', t('ui.6f1c2aae1ceb')),
  c('device', 'date', t('ui.f885bb12d35c'), t('ui.d2094a13ac3d'), t('ui.b4b8fed72cac'), 'date', t('ui.1f312733bed8')),
  c('device', 'id', t('ui.cf08a6e59e98'), t('ui.0f5e5ae830ed'), t('ui.b4b8fed72cac'), 'id', t('ui.3d7c40a51c82')),

  c('packages', 'pm list packages -3', t('ui.4d17f2472962'), t('ui.17fda2ddd6d1'), t('ui.f6b101bfab21'), 'pm list packages -3', t('ui.d1c718150bc1')),
  c('packages', 'pm list packages -s', t('ui.345d14421593'), t('ui.09d78f9d44d6'), t('ui.7b0348ec8b1a'), 'pm list packages -s', t('ui.40d5dd91a20d')),
  c('packages', 'pm list packages -d', t('ui.6007e040ecdf'), t('ui.05293f5bc606'), t('ui.094c666f2f29'), 'pm list packages -d', t('ui.9cab37d1d38c')),
  c('packages', 'pm list packages -e', t('ui.c0d079c7b952'), t('ui.89d2ee4866bf'), t('ui.db41d2005365'), 'pm list packages -e', t('ui.03f275f3b359')),
  c('packages', t('ui.91ab5a3ded89'), t('ui.7bc87f3d9de1'), t('ui.e9d01dc7fe1b'), t('ui.e70ae71862fc'), 'pm path com.android.settings', t('ui.3df46084c9fd')),
  c('packages', t('ui.eedc35f60190'), t('ui.c4e51d153504'), t('ui.ea14f153d1fc'), t('ui.e70ae71862fc'), 'pm dump com.android.settings', t('ui.6efa6b11e2c8')),
  c('packages', 'pm list permissions -g -d', t('ui.9278e15fc12c'), t('ui.9e482e61db2a'), t('ui.c5d57494c2bf'), 'pm list permissions -g -d', t('ui.2beb7199534b')),
  c('packages', t('ui.4c4353ffb236'), t('ui.880b2c2e51f8'), t('ui.f41d3ccfa455'), t('ui.e70ae71862fc'), 'pm clear com.example.app', t('ui.4db5cfff226c'), t('ui.75f8a0892364')),
  c('packages', t('ui.2232653564db'), t('ui.509ae7ac5ee3'), t('ui.0c8fdcdcf061'), t('ui.701485b2d2a1'), 'pm grant com.example.app android.permission.CAMERA', t('ui.2678d8f6314e'), t('ui.9cf39ce527f5')),
  c('packages', t('ui.9c71d8e79514'), t('ui.162ade56183a'), t('ui.ce0043648ee7'), t('ui.701485b2d2a1'), 'pm revoke com.example.app android.permission.CAMERA', t('ui.72fe0b375a1d'), t('ui.9cf39ce527f5')),

  c('activity', t('ui.d4b496e6e58e'), t('ui.873bd958d7a0'), t('ui.a4a803e48bae'), t('ui.0843a49e45c7'), 'am start -W -n com.android.settings/.Settings', t('ui.b42430d1df81')),
  c('activity', 'am start -a android.intent.action.VIEW -d <url>', t('ui.9fd68417faf2'), t('ui.fad8076dcc4e'), t('ui.5bd2b2b24214'), 'am start -a android.intent.action.VIEW -d https://example.com', t('ui.9620925db7dc')),
  c('activity', t('ui.b77eaaa4f65f'), t('ui.c3026391b519'), t('ui.a60fe4826765'), t('ui.e70ae71862fc'), 'am force-stop com.example.app', t('ui.6bd4b14f81a7'), t('ui.47d1b4cc374d')),
  c('activity', t('ui.9b5f3ec97eed'), t('ui.777a8d081251'), t('ui.525814304980'), t('ui.e1954ee5eba0'), 'am broadcast -a com.example.ACTION_TEST', t('ui.79bfa49b157f')),
  c('activity', t('ui.87a79d4d8839'), t('ui.3730a2a14cb5'), t('ui.e7a9cbd23154'), t('ui.5c0a66241dbe'), 'am startservice -n com.example.app/.MyService', t('ui.7f6845575ad3')),
  other('external', t('ui.df9ddcc38c7a'), t('ui.653f90b24e75'), t('ui.faa4910d9a59'), t('ui.bd828488ce92'), 'am instrument -w com.example.app.test/androidx.test.runner.AndroidJUnitRunner', t('ui.8a201d6d2755')),
  c('activity', 'am get-current-user', t('ui.a68a8c275b8e'), t('ui.15e6905e7b7d'), t('ui.b4b8fed72cac'), 'am get-current-user', t('ui.408d371aaf44')),

  c('settings', 'settings list global', t('ui.763764e22a92'), t('ui.2a5b390c0665'), t('ui.b8a1f9fa8662'), 'settings list global', t('ui.7900c7592c61')),
  c('settings', 'settings list system', t('ui.65053aab1fe1'), t('ui.f9069d998eef'), t('ui.7e6fae525838'), 'settings list system', t('ui.c3014a3ac9fe')),
  c('settings', 'settings list secure', t('ui.12cffb691f18'), t('ui.47736cf4575f'), t('ui.6dff9c35c8bb'), 'settings list secure', t('ui.b057db509cba')),
  c('settings', 'settings get system screen_brightness', t('ui.b95fd05cd5cc'), t('ui.1d77e9766412'), t('ui.dfb9dff39abd'), 'settings get system screen_brightness', t('ui.a016af3c7af5')),
  c('settings', 'settings put system screen_brightness <0-255>', t('ui.dec384473e9e'), t('ui.b1f87a174452'), t('ui.912d6878f8ee'), 'settings put system screen_brightness 128', t('ui.64d9eba6bdc9'), t('ui.f61672f93cf4')),
  c('settings', 'settings get system accelerometer_rotation', t('ui.338ae8ac01a8'), t('ui.fb8604ed96b3'), t('ui.dfb9dff39abd'), 'settings get system accelerometer_rotation', t('ui.2e306d27e5f4')),
  c('settings', 'settings put system accelerometer_rotation <0|1>', t('ui.eb34d213d0ed'), t('ui.7eb55e6df8dd'), t('ui.695bdd792d3e'), 'settings put system accelerometer_rotation 1', t('ui.3ce5459247d9'), t('ui.f61672f93cf4')),
  c('settings', 'settings get global airplane_mode_on', t('ui.090203d21af7'), t('ui.1cbf1885dfe6'), t('ui.547e4bb09c31'), 'settings get global airplane_mode_on', t('ui.2cbd4bf853f2')),

  c('diagnostics', 'dumpsys -l', t('ui.72ebfecdb292'), t('ui.94f78a99c35b'), t('ui.6b58f4f3e619'), 'dumpsys -l', t('ui.c36c7ffd473c')),
  c('diagnostics', 'dumpsys battery', t('ui.4ce39839e417'), t('ui.3bc968dc3b40'), t('ui.9e7fc8aea978'), 'dumpsys battery', t('ui.8e3f14f713f6')),
  c('diagnostics', 'dumpsys activity activities', t('ui.864069f6e56b'), t('ui.3bf5acc4c03a'), t('ui.692351292d58'), 'dumpsys activity activities', t('ui.25256a6c0707')),
  c('diagnostics', t('ui.056b85d74fb5'), t('ui.df5851dcc0f1'), t('ui.268ff69a5f47'), t('ui.e70ae71862fc'), 'dumpsys meminfo com.android.settings', t('ui.62c0dfbbccf3')),
  c('diagnostics', t('ui.fdb1de335cbc'), t('ui.9d3785eb9e12'), t('ui.834fcb51c91b'), t('ui.e70ae71862fc'), 'dumpsys package com.android.settings', t('ui.284d01dcc14b')),
  c('diagnostics', 'dumpsys window', t('ui.819b936d10dd'), t('ui.f415967a0c7b'), t('ui.4ab6146944b9'), 'dumpsys window', t('ui.28e787066cba')),
  c('diagnostics', 'dumpsys display', t('ui.097fa09bf46c'), t('ui.b9a687312c3b'), t('ui.0d5e4a3917af'), 'dumpsys display', t('ui.22493465b178')),
  c('diagnostics', 'dumpsys input', t('ui.73050ed51c2e'), t('ui.4021499122cf'), t('ui.39b9e125b123'), 'dumpsys input', t('ui.05d3de652eb6')),
  c('diagnostics', 'dumpsys connectivity', t('ui.8b0b387c9634'), t('ui.1c4da452e14a'), t('ui.b29e492bb0d7'), 'dumpsys connectivity', t('ui.1936d4ef2418')),

  c('input', 'input keyevent KEYCODE_HOME', t('ui.7deea0930f2c'), t('ui.54ba86a161e7'), t('ui.50bc9debb015'), 'input keyevent KEYCODE_HOME', t('ui.129ebbf4ca8d')),
  c('input', 'input keyevent KEYCODE_BACK', t('ui.c3168646017d'), t('ui.9297fcf80c4f'), t('ui.d9709dae3556'), 'input keyevent KEYCODE_BACK', t('ui.3d823b384d52')),
  c('input', 'input keyevent KEYCODE_POWER', t('ui.ffe25dd2be73'), t('ui.4728bf1671c4'), t('ui.92193f663537'), 'input keyevent KEYCODE_POWER', t('ui.b10969bfefe3'), t('ui.1ef8e31e8e87')),
  c('input', 'input keyevent KEYCODE_APP_SWITCH', t('ui.2d7ce9a5379c'), t('ui.1c161cc859b3'), t('ui.4366e4a6d49c'), 'input keyevent KEYCODE_APP_SWITCH', t('ui.69c4cbcdbf64')),
  c('input', 'input tap <x> <y>', t('ui.0f249994657f'), t('ui.836f70f49410'), t('ui.cf9dd6a3e6ca'), 'input tap 200 400', t('ui.0fe29a90a4c6')),
  c('input', t('ui.ae35c8b11f3a'), t('ui.c56902a42fe1'), t('ui.6da5fdc577e6'), t('ui.d27874c0a156'), 'input swipe 300 900 300 300 350', t('ui.5eca483738a5')),
  c('input', t('ui.a1d69e6dd5ba'), t('ui.4215fafd1015'), t('ui.faac35d5d160'), t('ui.a29ef896e736'), 'input text hello%sworld', t('ui.8ab530ab4475')),
  c('input', t('ui.bb22d363284e'), t('ui.dce27de83fc6'), t('ui.947c91e070f9'), t('ui.c885444933be'), 'input keyevent 66', t('ui.3cda9565ccd0')),

  c('files', 'ls -la /sdcard/Download', t('ui.d7e644c322bc'), t('ui.3e7c0b4cc562'), t('ui.a7a3d8a2b9b4'), 'ls -la /sdcard/Download', t('ui.821843cb90bb')),
  c('files', t('ui.72877e27d03d'), t('ui.b36b5b02d98a'), t('ui.049978663c45'), t('ui.455ea6894446'), 'stat /sdcard/Download/report.txt', t('ui.286880e70aa7')),
  c('files', t('ui.0d6d50ae8836'), t('ui.292a1395118a'), t('ui.eefd32a5c163'), t('ui.d1ad636d3b96'), 'cat /sdcard/Download/report.txt', t('ui.b48acd6c1cb4')),
  c('files', t('ui.ae0f08d47a42'), t('ui.fcead30f269d'), t('ui.a487c2bd3d9d'), t('ui.bd2e2fcc8dcb'), 'mkdir -p /sdcard/Download/reports', t('ui.a1c2b3ca62c9'), t('ui.1f3ee927a0e7')),
  c('files', t('ui.18a70a1a9687'), t('ui.35032a378518'), t('ui.452b42032223'), t('ui.500de3dc316f'), 'cp /sdcard/Download/a.txt /sdcard/Download/b.txt', t('ui.53a3f940b9dc'), t('ui.f40d9e6781b9')),
  c('files', t('ui.88ff603e2939'), t('ui.c21fd78fa2ef'), t('ui.8ead2b582971'), t('ui.500de3dc316f'), 'mv /sdcard/Download/a.txt /sdcard/Download/b.txt', t('ui.8505005296de'), t('ui.d77b9f8ee706')),
  c('files', t('ui.0475b3e56205'), t('ui.e64c2d1687e3'), t('ui.3db0e18a93a1'), t('ui.221ab563a0a2'), 'rm /sdcard/Download/report.txt', t('ui.7c161f643363'), t('ui.7836493e6126')),

  c('network', 'ip addr', t('ui.b06d033504fa'), t('ui.a28dc9c71404'), t('ui.b4b8fed72cac'), 'ip addr', t('ui.5dbb86151d90')),
  c('network', 'ip route', t('ui.ef36f99d7742'), t('ui.1ffc103d0be3'), t('ui.b4b8fed72cac'), 'ip route', t('ui.bfd844ab04b0')),
  c('network', t('ui.c52320d38393'), t('ui.87cb1172f2cd'), t('ui.9cc17025527a'), t('ui.632dfdb7cd88'), 'ping -c 1 1.1.1.1', t('ui.76c0a6f76ad2')),
  c('network', 'dumpsys wifi', t('ui.17a1cde7b99a'), t('ui.9398329719d2'), t('ui.4971198a41c9'), 'dumpsys wifi', t('ui.f8a3be114b21')),

  c('services', 'cmd -l', t('ui.2f1ac1e5baa0'), t('ui.b25e7f5f8177'), t('ui.0da205ce02b7'), 'cmd -l', t('ui.4e862fd35da8')),
  c('services', 'cmd package help', t('ui.ddf923368e92'), t('ui.7774c5b87b95'), t('ui.00b5924c8eab'), 'cmd package help', t('ui.a506e2e0d879')),
  c('services', 'cmd activity help', t('ui.707de216e802'), t('ui.745f6845109e'), t('ui.f174e7ee567d'), 'cmd activity help', t('ui.868421a6c39b')),
  c('services', 'cmd wifi help', t('ui.c05ef8459a9e'), t('ui.c709c2415146'), t('ui.8ef6431cd0d6'), 'cmd wifi help', t('ui.76071ef48766')),

  other('upload', 'install <apk>', t('ui.2cfc3c80ac2a'), t('ui.0c7d5924733c'), t('ui.dbe553da18cd'), t('ui.0e7e8d601974'), t('ui.ddba30ba7826')),
  other('upload', t('ui.e8401733ef5b'), t('ui.9f609274aaaf'), t('ui.0ad293a5dfa3'), t('ui.b5208f376146'), t('ui.5d104f10e6e6'), t('ui.713606bfa289')),
  other('external', t('ui.dbc8b7babac6'), t('ui.3237c7403f21'), t('ui.e5e28c8cd683'), t('ui.4895229d0cb2'), 'pull /sdcard/Download/report.txt .', t('ui.dc177d66857d')),
  other('external', 'exec-out screencap -p > screen.png', t('ui.5abd13662cbd'), t('ui.dedef83edb26'), t('ui.0e009c196f09'), 'exec-out screencap -p > screen.png', t('ui.62bc7ffb1e5e')),
  other('external', t('ui.c5933ed4fb1c'), t('ui.b5f7731b1e2f'), t('ui.d549c069c0fa'), t('ui.a625971d7cd8'), t('ui.4bdf3429f62a'), t('ui.209d7f8d8769')),
]; }
