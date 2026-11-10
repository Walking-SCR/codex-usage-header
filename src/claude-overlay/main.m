//
// Claude Quota Overlay - Native macOS Companion Window
// Automatically anchors to Claude.app's top-right header and renders the exact
// same Shadow DOM capsule and 590px rich popover card.
//
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <sys/stat.h>

@interface OverlayController : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, strong) NSPanel *panel;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) CGFloat currentWidth;
@property (nonatomic, assign) CGFloat currentHeight;
@property (nonatomic, assign) BOOL isExpanded;
@property (nonatomic, copy) NSString *lastStatusJson;
@property (nonatomic, strong) NSTimer *trackingTimer;
@property (nonatomic, strong) NSTimer *statusTimer;
@property (nonatomic, assign) CGFloat lastClaudeWidth;
@property (nonatomic, assign) NSInteger lastThemeDetected; // -1: uninit, 0: light, 1: dark
@property (nonatomic, assign) NSInteger mouseOutsideTicks;
@property (nonatomic, assign) time_t lastStatusMtime;
@property (nonatomic, assign) time_t lastConfigMtime;
@property (nonatomic, assign) BOOL lastThemeIsDark;
@end

@implementation OverlayController

- (instancetype)init {
    self = [super init];
    if (self) {
        _currentWidth = 390.0;
        _currentHeight = 42.0;
        _isExpanded = NO;
        _lastStatusJson = @"";
        _lastClaudeWidth = 0.0;
        _lastThemeDetected = -1;
        _lastStatusMtime = 0;
        _lastConfigMtime = 0;
        _lastThemeIsDark = NO;
        [self setupPanelAndWebView];
        [self startTimers];
    }
    return self;
}

- (BOOL)detectClaudeIsDark {
    NSString *p1 = [@"~/Library/Application Support/Claude-3p/config.json" stringByExpandingTildeInPath];
    NSString *p2 = [@"~/Library/Application Support/Claude/config.json" stringByExpandingTildeInPath];
    for (NSString *path in @[p1, p2]) {
        struct stat st;
        if (stat(path.fileSystemRepresentation, &st) == 0) {
            if (_lastConfigMtime == st.st_mtime && _lastThemeDetected >= 0) {
                return _lastThemeIsDark;
            }
            _lastConfigMtime = st.st_mtime;
            NSData *data = [NSData dataWithContentsOfFile:path];
            if (data) {
                NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if ([json isKindOfClass:[NSDictionary class]]) {
                    NSString *mode = json[@"userThemeMode"];
                    if ([mode isEqualToString:@"dark"]) { _lastThemeIsDark = YES; return YES; }
                    if ([mode isEqualToString:@"light"]) { _lastThemeIsDark = NO; return NO; }
                }
            }
        }
    }
    _lastThemeIsDark = [NSApp.effectiveAppearance.name containsString:@"Dark"];
    return _lastThemeIsDark;
}

- (void)setupPanelAndWebView {
    NSRect initialFrame = NSMakeRect(100, 100, _currentWidth, _currentHeight);
    _panel = [[NSPanel alloc] initWithContentRect:initialFrame
                                        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                          backing:NSBackingStoreBuffered
                                            defer:NO];
    _panel.level = NSStatusWindowLevel;
    _panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
    _panel.opaque = NO;
    _panel.backgroundColor = [NSColor clearColor];
    _panel.hasShadow = NO;
    _panel.ignoresMouseEvents = NO;
    _panel.hidesOnDeactivate = NO;

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    WKUserContentController *ucc = [[WKUserContentController alloc] init];
    [ucc addScriptMessageHandler:self name:@"overlay"];
    config.userContentController = ucc;

    [config.preferences setValue:@YES forKey:@"allowFileAccessFromFileURLs"];
    [config setValue:@YES forKey:@"allowUniversalAccessFromFileURLs"];

    _webView = [[WKWebView alloc] initWithFrame:_panel.contentView.bounds configuration:config];
    _webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [_webView setValue:@NO forKey:@"drawsBackground"];
    _webView.navigationDelegate = self;

    [_panel.contentView addSubview:_webView];

    NSString *htmlPath = @"/Users/scr/Documents/Project/codex-usage-header/src/claude-overlay/overlay.html";
    NSURL *fileUrl = [NSURL fileURLWithPath:htmlPath];
    NSURL *accessUrl = [NSURL fileURLWithPath:@"/Users/scr/Documents/Project/codex-usage-header/"];
    [_webView loadFileURL:fileUrl allowingReadAccessToURL:accessUrl];
}

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *dict = (NSDictionary *)message.body;
    BOOL expanded = [dict[@"expanded"] boolValue];
    CGFloat w = [dict[@"width"] doubleValue] ?: (_currentWidth);
    CGFloat h = [dict[@"height"] doubleValue] ?: (_currentHeight);

    dispatch_async(dispatch_get_main_queue(), ^{
        self.isExpanded = expanded;
        self.currentWidth = w;
        self.currentHeight = h;
        [self updateWindowPosition];
    });
}

- (void)startTimers {
    // 窗口跟随定时器（120ms 低开销吸附）
    _trackingTimer = [NSTimer scheduledTimerWithTimeInterval:0.12
                                                      target:self
                                                    selector:@selector(updateWindowPosition)
                                                    userInfo:nil
                                                     repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:_trackingTimer forMode:NSRunLoopCommonModes];

    // 数据同步定时器（每秒读取一次 live-status.json）
    _statusTimer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                    target:self
                                                  selector:@selector(pollStatusFile)
                                                  userInfo:nil
                                                   repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:_statusTimer forMode:NSRunLoopCommonModes];
}

- (void)pollStatusFile {
    // 1. 同步检测 Claude 外观主题（跟随 Claude 设置中的 userThemeMode: dark/light/system）
    BOOL isDark = [self detectClaudeIsDark];
    if (_lastThemeDetected != (isDark ? 1 : 0)) {
        _lastThemeDetected = (isDark ? 1 : 0);
        NSString *themeJs = [NSString stringWithFormat:@"window.__setTheme && window.__setTheme(%@);", isDark ? @"true" : @"false"];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:themeJs completionHandler:nil];
        });
    }

    // 2. 读取并同步实时用量数据（mtime 守卫：未发生内容变化时零磁盘读取与解析）
    NSString *statusPath = [@"~/Library/Application Support/Codex Quota Header/live-status.json" stringByExpandingTildeInPath];
    struct stat st;
    if (stat(statusPath.fileSystemRepresentation, &st) != 0) return;
    if (st.st_mtime == _lastStatusMtime && _lastStatusMtime > 0) return;

    NSData *data = [NSData dataWithContentsOfFile:statusPath];
    if (!data) return;
    _lastStatusMtime = st.st_mtime;

    NSString *content = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (content && ![content isEqualToString:_lastStatusJson]) {
        _lastStatusJson = content;
        NSData *escapedData = [NSJSONSerialization dataWithJSONObject:@{@"json": content} options:0 error:nil];
        NSString *wrapper = [[NSString alloc] initWithData:escapedData encoding:NSUTF8StringEncoding];
        NSString *js = [NSString stringWithFormat:@"(() => { try { const payload = JSON.parse(%@.json); window.__updateFromStatusFile(payload); } catch(e) {} })()", wrapper];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:js completionHandler:nil];
        });
    }
}

- (void)updateWindowPosition {
    // 性能优化：优先检测当前前台活跃应用。若用户在其它程序（微信、浏览器等），零开销退出
    NSRunningApplication *frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    BOOL isClaudeFront = [frontApp.bundleIdentifier isEqualToString:@"com.anthropic.claudefordesktop"];
    if (!isClaudeFront && !_isExpanded) {
        if (_panel.isVisible) [_panel orderOut:nil];
        return;
    }

    NSArray<NSRunningApplication *> *apps = [[NSWorkspace sharedWorkspace] runningApplications];
    NSRunningApplication *claudeApp = nil;
    for (NSRunningApplication *app in apps) {
        if ([app.bundleIdentifier isEqualToString:@"com.anthropic.claudefordesktop"]) {
            claudeApp = app;
            break;
        }
    }

    // 如果 Claude 未运行或已隐藏 (Cmd+H)，立即从桌面隐藏胶囊
    if (!claudeApp || claudeApp.isHidden) {
        if (_panel.isVisible) [_panel orderOut:nil];
        return;
    }

    CFArrayRef windowList = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
    if (!windowList) return;

    CGRect mainClaudeBounds = CGRectZero;
    CGFloat maxArea = 0;
    BOOL found = NO;

    for (NSDictionary *info in (__bridge NSArray *)windowList) {
        if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] == claudeApp.processIdentifier) {
            int layer = [info[(__bridge NSString *)kCGWindowLayer] intValue];
            if (layer != 0) continue;

            // 解决问题 1：关键点——最小化到 Dock (Cmd+M) 时，isOnScreen 严格为 0，必须视为窗口不可见！
            BOOL isOnScreen = [info[(__bridge NSString *)kCGWindowIsOnscreen] boolValue];
            if (!isOnScreen) continue;

            NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
            CGFloat w = [bounds[@"Width"] doubleValue];
            CGFloat h = [bounds[@"Height"] doubleValue];
            CGFloat area = w * h;
            // 严格选出 Claude 主窗口（排除侧栏/小悬浮层）
            if (area > maxArea && w >= 500 && h >= 300) {
                maxArea = area;
                mainClaudeBounds = CGRectMake([bounds[@"X"] doubleValue],
                                              [bounds[@"Y"] doubleValue],
                                              w, h);
                found = YES;
            }
        }
    }
    CFRelease(windowList);

    // 窗口最小化或关闭时，隐藏胶囊
    if (!found) {
        if (!_isExpanded && _panel.isVisible) [_panel orderOut:nil];
        return;
    }

    // 解决问题 2：宽度自适应。当 Claude 窗口宽度变化时通知前端重新计算模式 (full/compact/minimal/nano)
    CGFloat claudeW = mainClaudeBounds.size.width;
    if (fabs(claudeW - _lastClaudeWidth) > 8.0) {
        _lastClaudeWidth = claudeW;
        NSString *widthJs = [NSString stringWithFormat:@"window.__setClaudeWidth && window.__setClaudeWidth(%.0f);", claudeW];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:widthJs completionHandler:nil];
        });
    }

    CGFloat primaryScreenH = NSScreen.screens[0].frame.size.height;
    // 右侧避让 Claude 顶栏右侧的 5 个图标按钮（分栏、终端、代码、运行、头像），保持 196px 间距
    CGFloat rightPadding = 196.0;
    CGFloat topPadding = 4.0;

    CGFloat targetX = mainClaudeBounds.origin.x + mainClaudeBounds.size.width - _currentWidth - rightPadding;
    CGFloat targetY = primaryScreenH - (mainClaudeBounds.origin.y + topPadding + _currentHeight);

    NSRect targetFrame = NSMakeRect(targetX, targetY, _currentWidth, _currentHeight);
    if (!NSEqualRects(targetFrame, _panel.frame)) {
        [_panel setFrame:targetFrame display:YES animate:NO];
    }

    if (!_panel.isVisible) {
        [_panel orderFront:nil];
    }

    // 当展开卡片时，如果鼠标移出下拉卡片范围（或点击外部区域），自动收起卡片
    if (_isExpanded) {
        NSPoint mouseLoc = [NSEvent mouseLocation];
        if (!NSPointInRect(mouseLoc, _panel.frame)) {
            self.mouseOutsideTicks++;
            if (self.mouseOutsideTicks >= 3) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    [self.webView evaluateJavaScript:@"window.__codexUsageHeaderDebug__?.hidePopover?.();" completionHandler:nil];
                });
            }
        } else {
            self.mouseOutsideTicks = 0;
        }
    } else {
        self.mouseOutsideTicks = 0;
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    _lastThemeDetected = -1;
    [self pollStatusFile];
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        OverlayController *controller = [[OverlayController alloc] init];
        [app run];
    }
    return 0;
}
