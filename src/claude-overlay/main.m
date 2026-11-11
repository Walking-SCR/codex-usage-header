//
// Claude Quota Overlay - Native macOS Companion Window
// Automatically anchors to Claude.app's conversation header (even when File/Diff/Terminal
// split panes are open) and renders the exact Shadow DOM capsule and 590px rich popover card.
//
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <sys/stat.h>
#include <dirent.h>

typedef struct {
    CGRect rect;
    BOOL isSmallIcon;
    BOOL isText;
    BOOL isWideTitle;
} HeaderItem;

static BOOL axGetRect(AXUIElementRef el, CGRect *outRect) {
    CFTypeRef posRef = NULL, sizeRef = NULL;
    if (AXUIElementCopyAttributeValue(el, kAXPositionAttribute, &posRef) != kAXErrorSuccess || !posRef) {
        return NO;
    }
    if (AXUIElementCopyAttributeValue(el, kAXSizeAttribute, &sizeRef) != kAXErrorSuccess || !sizeRef) {
        CFRelease(posRef);
        return NO;
    }
    CGPoint pt = CGPointZero;
    CGSize sz = CGSizeZero;
    BOOL ok = AXValueGetValue(posRef, kAXValueCGPointType, &pt) && AXValueGetValue(sizeRef, kAXValueCGSizeType, &sz);
    CFRelease(posRef);
    CFRelease(sizeRef);
    if (ok && outRect) {
        *outRect = CGRectMake(pt.x, pt.y, sz.width, sz.height);
    }
    return ok;
}

static NSString *axCopyStringAttr(AXUIElementRef el, CFStringRef attr) {
    CFTypeRef ref = NULL;
    if (AXUIElementCopyAttributeValue(el, attr, &ref) != kAXErrorSuccess || !ref) return nil;
    NSString *res = nil;
    if (CFGetTypeID(ref) == CFStringGetTypeID()) {
        res = [(__bridge NSString *)ref copy];
    }
    CFRelease(ref);
    return res;
}

static NSData *snappyDecompressData(const uint8_t *src, size_t srcLen) {
    if (!src || srcLen == 0) return nil;
    size_t i = 0;
    uint64_t ulen = 0;
    int shift = 0;
    while (i < srcLen && shift < 35) {
        uint8_t b = src[i++];
        ulen |= (uint64_t)(b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    if (ulen == 0 || ulen > 4 * 1024 * 1024) return nil;
    NSMutableData *out = [NSMutableData dataWithCapacity:(NSUInteger)ulen];
    while (i < srcLen) {
        uint8_t tag = src[i++];
        uint8_t type = tag & 0x03;
        if (type == 0) {
            size_t len = (tag >> 2) + 1;
            if (len > 60) {
                size_t extra = len - 60;
                if (extra > 4 || i + extra > srcLen) return nil;
                len = 0;
                for (size_t k = 0; k < extra; k++) len |= ((size_t)src[i + k]) << (8 * k);
                len += 1;
                i += extra;
            }
            if (i + len > srcLen) return nil;
            [out appendBytes:(src + i) length:len];
            i += len;
        } else {
            size_t len = 0, offset = 0;
            if (type == 1) {
                len = ((tag >> 2) & 0x07) + 4;
                if (i >= srcLen) return nil;
                offset = ((size_t)(tag & 0xe0) << 3) | src[i++];
            } else if (type == 2) {
                len = (tag >> 2) + 1;
                if (i + 2 > srcLen) return nil;
                offset = (size_t)src[i] | ((size_t)src[i + 1] << 8);
                i += 2;
            } else {
                len = (tag >> 2) + 1;
                if (i + 4 > srcLen) return nil;
                offset = (size_t)src[i] | ((size_t)src[i + 1] << 8) | ((size_t)src[i + 2] << 16) | ((size_t)src[i + 3] << 24);
                i += 4;
            }
            NSUInteger curLen = out.length;
            if (offset == 0 || offset > curLen) return nil;
            const uint8_t *bytes = (const uint8_t *)out.bytes;
            for (size_t k = 0; k < len; k++) {
                uint8_t b = bytes[curLen - offset + k];
                [out appendBytes:&b length:1];
                bytes = (const uint8_t *)out.bytes;
                curLen++;
            }
        }
    }
    return out;
}

static NSString *extractLastJsonObjectForKey(NSData *haystack, const char *keyNeedle, const char *jsonStartNeedle) {
    if (!haystack || haystack.length == 0) return nil;
    NSData *keyData = [NSData dataWithBytes:keyNeedle length:strlen(keyNeedle)];
    NSData *jsonStartData = [NSData dataWithBytes:jsonStartNeedle length:strlen(jsonStartNeedle)];
    NSRange searchRange = NSMakeRange(0, haystack.length);
    NSRange lastKeyRange = NSMakeRange(NSNotFound, 0);
    while (searchRange.location < haystack.length) {
        NSRange found = [haystack rangeOfData:keyData options:0 range:searchRange];
        if (found.location == NSNotFound) break;
        lastKeyRange = found;
        NSUInteger nextLoc = found.location + found.length;
        searchRange = NSMakeRange(nextLoc, haystack.length - nextLoc);
    }
    if (lastKeyRange.location == NSNotFound) return nil;
    NSUInteger startSearch = lastKeyRange.location + lastKeyRange.length;
    NSUInteger maxWindow = MIN((NSUInteger)65536, haystack.length - startSearch);
    NSRange startFound = [haystack rangeOfData:jsonStartData options:0 range:NSMakeRange(startSearch, maxWindow)];
    if (startFound.location == NSNotFound) return nil;

    const uint8_t *bytes = (const uint8_t *)haystack.bytes;
    NSUInteger jsonStart = startFound.location;
    int depth = 0;
    BOOL inString = NO;
    BOOL escaped = NO;
    NSUInteger limit = MIN(haystack.length, jsonStart + 131072);
    for (NSUInteger pos = jsonStart; pos < limit; pos++) {
        uint8_t ch = bytes[pos];
        if (inString) {
            if (escaped) { escaped = NO; }
            else if (ch == '\\') { escaped = YES; }
            else if (ch == '"') { inString = NO; }
        } else {
            if (ch == '"') { inString = YES; }
            else if (ch == '{') { depth++; }
            else if (ch == '}') {
                depth--;
                if (depth == 0) {
                    return [[NSString alloc] initWithBytes:(bytes + jsonStart) length:(pos - jsonStart + 1) encoding:NSUTF8StringEncoding];
                }
            }
        }
    }
    return nil;
}

@interface OverlayController : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, strong) NSPanel *panel;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) CGFloat currentWidth;
@property (nonatomic, assign) CGFloat currentHeight;
@property (nonatomic, assign) CGFloat capsuleHeight;
@property (nonatomic, assign) BOOL isExpanded;
@property (nonatomic, copy) NSString *lastStatusJson;
@property (nonatomic, strong) NSTimer *trackingTimer;
@property (nonatomic, strong) NSTimer *statusTimer;
@property (nonatomic, assign) CGFloat lastAvailableWidth;
@property (nonatomic, assign) CGFloat lastClaudeWidth;
@property (nonatomic, assign) CGFloat lastRightInset;
@property (nonatomic, assign) NSInteger lastThemeDetected; // -1: uninit, 0: light, 1: dark
@property (nonatomic, assign) NSInteger mouseOutsideTicks;
@property (nonatomic, assign) time_t lastStatusMtime;
@property (nonatomic, assign) time_t lastConfigMtime;
@property (nonatomic, assign) BOOL lastThemeIsDark;

// AXUIElement real-time header anchor cache
@property (nonatomic, assign) pid_t axEnabledPid;
@property (nonatomic, assign) BOOL axPrompted;
@property (nonatomic, assign) NSTimeInterval lastAxScanTime;
@property (nonatomic, assign) CGRect lastScannedWinBounds;
@property (nonatomic, assign) BOOL cachedAxValid;
@property (nonatomic, assign) CGFloat cachedAxAnchorRightX;
@property (nonatomic, assign) CGFloat cachedAxAvailableGap;
@property (nonatomic, assign) CGFloat cachedAxToolbarMidY;
@property (nonatomic, assign) AXUIElementRef cachedToolbar;
@property (nonatomic, assign) NSTimeInterval activeResizeUntil;

// LevelDB zero-permission fallback cache
@property (nonatomic, assign) NSTimeInterval lastLdbScanTime;
@property (nonatomic, assign) time_t lastLdbDirMtime;
@property (nonatomic, assign) CGFloat ldbSidebarWidth;
@property (nonatomic, assign) BOOL ldbSidebarCollapsed;
@property (nonatomic, assign) CGFloat ldbChatRatio;
@end

@implementation OverlayController

- (void)dealloc {
    if (_cachedToolbar) {
        CFRelease(_cachedToolbar);
        _cachedToolbar = NULL;
    }
    [super dealloc];
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _currentWidth = 376.0;
        _currentHeight = 42.0;
        _capsuleHeight = 34.0;
        _isExpanded = NO;
        _lastStatusJson = @"";
        _lastAvailableWidth = -1.0;
        _lastClaudeWidth = 0.0;
        _lastRightInset = -1.0;
        _lastThemeDetected = -1;
        _lastStatusMtime = 0;
        _lastConfigMtime = 0;
        _lastThemeIsDark = NO;
        _axEnabledPid = 0;
        _axPrompted = NO;
        _lastAxScanTime = 0;
        _lastScannedWinBounds = CGRectZero;
        _cachedAxValid = NO;
        _cachedAxToolbarMidY = 22.0;
        _cachedToolbar = NULL;
        _activeResizeUntil = 0;
        _lastLdbScanTime = 0;
        _lastLdbDirMtime = 0;
        _ldbSidebarWidth = 288.0;
        _ldbSidebarCollapsed = NO;
        _ldbChatRatio = 1.0;
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

- (NSString *)resolveOverlayHtmlPath {
    NSString *execDir = [[NSProcessInfo processInfo].arguments.firstObject stringByDeletingLastPathComponent];
    NSString *relPath = [[execDir stringByAppendingPathComponent:@"../src/claude-overlay/overlay.html"] stringByStandardizingPath];
    if ([[NSFileManager defaultManager] fileExistsAtPath:relPath]) {
        return relPath;
    }
    return @"/Users/scr/Documents/Project/codex-usage-header/src/claude-overlay/overlay.html";
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

    NSString *htmlPath = [self resolveOverlayHtmlPath];
    NSString *rootDir = [[htmlPath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
    rootDir = [rootDir stringByDeletingLastPathComponent];
    NSURL *fileUrl = [NSURL fileURLWithPath:htmlPath];
    NSURL *accessUrl = [NSURL fileURLWithPath:rootDir];
    [_webView loadFileURL:fileUrl allowingReadAccessToURL:accessUrl];
}

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *dict = (NSDictionary *)message.body;
    BOOL expanded = [dict[@"expanded"] boolValue];
    CGFloat w = [dict[@"width"] doubleValue] ?: _currentWidth;
    CGFloat h = [dict[@"height"] doubleValue] ?: _currentHeight;
    CGFloat capH = [dict[@"capsuleHeight"] doubleValue];

    dispatch_async(dispatch_get_main_queue(), ^{
        self.isExpanded = expanded;
        self.currentWidth = w;
        self.currentHeight = h;
        if (capH > 10.0) self.capsuleHeight = capH;
        [self updateWindowPosition];
    });
}

- (void)adjustTimerSpeed:(NSTimeInterval)desiredInterval {
    if (_trackingTimer && fabs(_trackingTimer.timeInterval - desiredInterval) < 0.005) return;
    if (_trackingTimer) [_trackingTimer invalidate];
    _trackingTimer = [NSTimer scheduledTimerWithTimeInterval:desiredInterval
                                                      target:self
                                                    selector:@selector(updateWindowPosition)
                                                    userInfo:nil
                                                     repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:_trackingTimer forMode:NSRunLoopCommonModes];
}

- (void)startTimers {
    _trackingTimer = [NSTimer scheduledTimerWithTimeInterval:0.04
                                                      target:self
                                                    selector:@selector(updateWindowPosition)
                                                    userInfo:nil
                                                     repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:_trackingTimer forMode:NSRunLoopCommonModes];

    _statusTimer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                    target:self
                                                  selector:@selector(pollStatusFile)
                                                  userInfo:nil
                                                   repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:_statusTimer forMode:NSRunLoopCommonModes];
}

- (void)pollStatusFile {
    BOOL isDark = [self detectClaudeIsDark];
    if (_lastThemeDetected != (isDark ? 1 : 0)) {
        _lastThemeDetected = (isDark ? 1 : 0);
        NSString *themeJs = [NSString stringWithFormat:@"window.__setTheme && window.__setTheme(%@);", isDark ? @"true" : @"false"];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:themeJs completionHandler:nil];
        });
    }

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

- (void)pollLevelDbFallbackLayout {
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    NSTimeInterval minInterval = (now < _activeResizeUntil) ? 0.35 : 1.5;
    if (now - _lastLdbScanTime < minInterval) return;
    _lastLdbScanTime = now;

    NSString *dir1 = [@"~/Library/Application Support/Claude-3p/Local Storage/leveldb" stringByExpandingTildeInPath];
    NSString *dir2 = [@"~/Library/Application Support/Claude/Local Storage/leveldb" stringByExpandingTildeInPath];
    NSString *ldbDir = nil;
    struct stat dirStat;
    time_t newestDirTime = 0;
    for (NSString *cand in @[dir1, dir2]) {
        if (stat(cand.fileSystemRepresentation, &dirStat) == 0 && dirStat.st_mtime >= newestDirTime) {
            newestDirTime = dirStat.st_mtime;
            ldbDir = cand;
        }
    }
    if (!ldbDir) return;

    // 找出最新的 .log 与 .ldb 文件及其 mtime
    NSString *newestLog = nil, *newestLdb = nil;
    time_t maxFileMtime = newestDirTime;
    time_t logMtime = 0, ldbMtime = 0;
    DIR *dp = opendir(ldbDir.fileSystemRepresentation);
    if (!dp) return;
    struct dirent *entry;
    while ((entry = readdir(dp)) != NULL) {
        NSString *name = [NSString stringWithUTF8String:entry->d_name];
        if (![name hasSuffix:@".log"] && ![name hasSuffix:@".ldb"]) continue;
        NSString *full = [ldbDir stringByAppendingPathComponent:name];
        struct stat fst;
        if (stat(full.fileSystemRepresentation, &fst) != 0) continue;
        if (fst.st_mtime > maxFileMtime) maxFileMtime = fst.st_mtime;
        if ([name hasSuffix:@".log"] && fst.st_mtime >= logMtime) {
            logMtime = fst.st_mtime;
            newestLog = full;
        } else if ([name hasSuffix:@".ldb"] && fst.st_mtime >= ldbMtime) {
            ldbMtime = fst.st_mtime;
            newestLdb = full;
        }
    }
    closedir(dp);

    if (maxFileMtime == _lastLdbDirMtime && _lastLdbDirMtime > 0) return;
    _lastLdbDirMtime = maxFileMtime;

    NSMutableArray<NSData *> *blobs = [NSMutableArray array];
    if (newestLog) {
        NSData *logData = [NSData dataWithContentsOfFile:newestLog];
        if (logData) [blobs addObject:logData];
    }
    if (newestLdb) {
        NSData *ldbData = [NSData dataWithContentsOfFile:newestLdb];
        if (ldbData && ldbData.length > 48) {
            // 对 .ldb 文件直接尝试解析完整原始字节与内部 Snappy 数据块
            [blobs addObject:ldbData];
            const uint8_t *raw = (const uint8_t *)ldbData.bytes;
            size_t len = ldbData.length;
            // LevelDB .ldb 的 5 字节块尾为 [type(1B)=1(snappy), crc(4B)]，从页索引或扫描中还原常见小块
            // 若在 .log 中尚未被合并，.ldb 中也保留了原始索引末尾信息
            size_t footerStart = len - 48;
            size_t o = footerStart;
            uint64_t dummy = 0; int sh = 0;
            // skip metaindex handle (2 varints)
            for (int v = 0; v < 2 && o < len; v++) {
                while (o < len && (raw[o] & 0x80)) o++;
                if (o < len) o++;
            }
            uint64_t idxOff = 0, idxSz = 0;
            sh = 0;
            while (o < len) { uint8_t b = raw[o++]; idxOff |= (uint64_t)(b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
            sh = 0;
            while (o < len) { uint8_t b = raw[o++]; idxSz |= (uint64_t)(b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
            (void)dummy;
            if (idxOff + idxSz + 5 <= len && idxSz > 8) {
                NSData *idxBlock = raw[idxOff + idxSz] == 1
                    ? snappyDecompressData(raw + idxOff, (size_t)idxSz)
                    : [NSData dataWithBytes:(raw + idxOff) length:(size_t)idxSz];
                if (idxBlock && idxBlock.length >= 8) {
                    const uint8_t *ib = (const uint8_t *)idxBlock.bytes;
                    uint32_t restarts = 0;
                    memcpy(&restarts, ib + idxBlock.length - 4, 4);
                    if (idxBlock.length >= 4 + 4 * (size_t)restarts) {
                        size_t limit = idxBlock.length - 4 - 4 * (size_t)restarts;
                        size_t p = 0;
                        while (p < limit) {
                            // shared, non_shared, vlen
                            while (p < limit && (ib[p] & 0x80)) p++; if (p < limit) p++;
                            uint64_t nonShared = 0, vlen = 0;
                            sh = 0; while (p < limit) { uint8_t b = ib[p++]; nonShared |= (uint64_t)(b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
                            sh = 0; while (p < limit) { uint8_t b = ib[p++]; vlen |= (uint64_t)(b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
                            if (p + nonShared + vlen > limit) break;
                            p += (size_t)nonShared;
                            size_t vp = p; p += (size_t)vlen;
                            uint64_t boff = 0, bsz = 0;
                            sh = 0; while (vp < p) { uint8_t b = ib[vp++]; boff |= (uint64_t)(b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
                            sh = 0; while (vp < p) { uint8_t b = ib[vp++]; bsz |= (uint64_t)(b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
                            if (boff + bsz + 1 <= len && raw[boff + bsz] == 1) {
                                NSData *dec = snappyDecompressData(raw + boff, (size_t)bsz);
                                if (dec) [blobs addObject:dec];
                            }
                        }
                    }
                }
            }
        }
    }

    NSString *frameJsonStr = nil;
    NSString *paneJsonStr = nil;
    for (NSData *blob in blobs) {
        if (!frameJsonStr) {
            frameJsonStr = extractLastJsonObjectForKey(blob, "frame-store", "{\"state\":");
        }
        if (!paneJsonStr) {
            paneJsonStr = extractLastJsonObjectForKey(blob, "epitaxy.sidePaneStore.v1", "{\"state\":");
        }
    }

    if (frameJsonStr) {
        NSDictionary *obj = [NSJSONSerialization JSONObjectWithData:[frameJsonStr dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSDictionary *st = [obj isKindOfClass:[NSDictionary class]] ? obj[@"state"] : nil;
        if ([st isKindOfClass:[NSDictionary class]]) {
            if (st[@"collapsed"]) _ldbSidebarCollapsed = [st[@"collapsed"] boolValue];
            if ([st[@"sidebarWidth"] doubleValue] > 100.0) _ldbSidebarWidth = [st[@"sidebarWidth"] doubleValue];
        }
    }
    if (paneJsonStr) {
        NSDictionary *obj = [NSJSONSerialization JSONObjectWithData:[paneJsonStr dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSDictionary *st = [obj isKindOfClass:[NSDictionary class]] ? obj[@"state"] : nil;
        if ([st isKindOfClass:[NSDictionary class]]) {
            NSDictionary *layout = st[@"tileLayout"];
            NSString *curId = st[@"currentSessionId"];
            NSDictionary *bySess = st[@"tileLayoutBySession"];
            if ([curId isKindOfClass:[NSString class]] && [bySess isKindOfClass:[NSDictionary class]]) {
                NSDictionary *sessLayout = bySess[curId];
                if ([sessLayout isKindOfClass:[NSDictionary class]] && [layout[@"root"][@"children"] count] <= 1) {
                    layout = sessLayout;
                }
            }
            NSArray *children = layout[@"root"][@"children"];
            if ([children isKindOfClass:[NSArray class]] && children.count > 1) {
                CGFloat totalFlex = 0.0, chatFlex = 0.0;
                for (NSDictionary *tile in children) {
                    if (![tile isKindOfClass:[NSDictionary class]]) continue;
                    CGFloat fx = [tile[@"flex"] doubleValue];
                    if (fx <= 0) fx = 1.0;
                    totalFlex += fx;
                    if ([tile[@"tileId"] isEqualToString:@"chat"]) chatFlex += fx;
                }
                if (totalFlex > 0.0 && chatFlex > 0.0 && chatFlex < totalFlex) {
                    _ldbChatRatio = chatFlex / totalFlex;
                } else {
                    _ldbChatRatio = 1.0;
                }
            } else {
                _ldbChatRatio = 1.0;
            }
        }
    }
}

- (BOOL)parseToolbarChildren:(AXUIElementRef)tb winBounds:(CGRect)winBounds {
    CGRect tbRect = CGRectZero;
    if (!axGetRect(tb, &tbRect) || tbRect.size.width < 50 || tbRect.size.height < 15) return NO;
    if (tbRect.origin.y > winBounds.origin.y + 44.0 || CGRectGetMaxY(tbRect) < winBounds.origin.y - 4.0) return NO;

    CFTypeRef chRef = NULL;
    if (AXUIElementCopyAttributeValue(tb, kAXChildrenAttribute, &chRef) != kAXErrorSuccess || !chRef) return NO;
    NSArray *groups = (__bridge NSArray *)chRef;
    if (groups.count < 2) { CFRelease(chRef); return NO; }

    // Group 0: title + dropdown
    AXUIElementRef g0 = (__bridge AXUIElementRef)groups[0];
    CGRect g0Rect = CGRectZero;
    axGetRect(g0, &g0Rect);
    CGFloat titleRightX = CGRectGetMaxX(g0Rect);

    // Group Last: action buttons
    AXUIElementRef gLast = (__bridge AXUIElementRef)groups.lastObject;
    CGRect gLastRect = CGRectZero;
    axGetRect(gLast, &gLastRect);

    CFTypeRef btnsRef = NULL;
    AXUIElementCopyAttributeValue(gLast, kAXChildrenAttribute, &btnsRef);
    NSArray *btns = (__bridge NSArray *)btnsRef;
    CGFloat firstBtnX = gLastRect.origin.x;
    if (btns && btns.count > 0) {
        for (id btnObj in btns) {
            CGRect bRect = CGRectZero;
            if (axGetRect((__bridge AXUIElementRef)btnObj, &bRect) && bRect.origin.x >= winBounds.origin.x + 185.0 && bRect.size.width >= 16.0) {
                firstBtnX = bRect.origin.x;
                break;
            }
        }
    }
    if (btnsRef) CFRelease(btnsRef);
    CFRelease(chRef);

    CGFloat anchorX = firstBtnX - 6.0;
    CGFloat gap = anchorX - titleRightX - 8.0;
    if (gap < 40.0) gap = 40.0;

    _cachedAxAnchorRightX = anchorX;
    _cachedAxAvailableGap = gap;
    _cachedAxToolbarMidY = CGRectGetMidY(tbRect) - winBounds.origin.y;
    _cachedAxValid = YES;
    return YES;
}

- (BOOL)scanClaudeHeaderViaAX:(pid_t)claudePid winBounds:(CGRect)winBounds {
    if (!AXIsProcessTrusted()) {
        if (!_axPrompted) {
            _axPrompted = YES;
            NSDictionary *opts = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
            AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
        }
        _cachedAxValid = NO;
        return NO;
    }

    // 1. Fast path with cachedToolbar (< 0.3ms!)
    if (_cachedToolbar) {
        if ([self parseToolbarChildren:_cachedToolbar winBounds:winBounds]) {
            return YES;
        }
        CFRelease(_cachedToolbar);
        _cachedToolbar = NULL;
    }

    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    NSTimeInterval minScanInterval = (now < _activeResizeUntil) ? 0.05 : 0.15;
    if (_cachedAxValid && (now - _lastAxScanTime) < minScanInterval && CGRectEqualToRect(winBounds, _lastScannedWinBounds)) {
        return YES;
    }
    _lastAxScanTime = now;
    _lastScannedWinBounds = winBounds;

    AXUIElementRef axApp = AXUIElementCreateApplication(claudePid);
    if (!axApp) return NO;
    if (_axEnabledPid != claudePid) {
        AXUIElementSetAttributeValue(axApp, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
        _axEnabledPid = claudePid;
    }

    CFTypeRef winRef = NULL;
    if (AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute, &winRef) != kAXErrorSuccess || !winRef) {
        AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute, &winRef);
    }
    if (!winRef) {
        CFTypeRef winsRef = NULL;
        if (AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute, &winsRef) == kAXErrorSuccess && winsRef) {
            NSArray *wins = (__bridge NSArray *)winsRef;
            if (wins.count > 0) {
                winRef = CFRetain((__bridge CFTypeRef)wins[0]);
            }
            CFRelease(winsRef);
        }
    }
    CFRelease(axApp);
    if (!winRef) {
        _cachedAxValid = NO;
        return NO;
    }

    CGFloat headerTop = winBounds.origin.y - 4.0;
    CGFloat headerBottom = winBounds.origin.y + 44.0;

    NSMutableArray *stack = [NSMutableArray arrayWithObject:@{@"el": (__bridge id)winRef, @"depth": @0}];
    CFRelease(winRef);

    AXUIElementRef foundTb = NULL;
    NSInteger visited = 0;
    while (stack.count > 0 && visited < 450) {
        NSDictionary *node = stack.lastObject;
        [stack removeLastObject];
        AXUIElementRef el = (__bridge AXUIElementRef)node[@"el"];
        NSInteger depth = [node[@"depth"] integerValue];
        visited++;

        CGRect rect = CGRectZero;
        BOOL hasRect = axGetRect(el, &rect);
        if (hasRect && rect.size.width > 0 && rect.size.height > 0) {
            if (rect.origin.y > headerBottom || CGRectGetMaxY(rect) < headerTop) {
                continue; // 剪枝：完全脱离顶部栏区域
            }
        }

        NSString *role = axCopyStringAttr(el, kAXRoleAttribute);
        if ([role isEqualToString:@"AXToolbar"]) {
            NSString *title = axCopyStringAttr(el, kAXTitleAttribute);
            if (![title isEqualToString:@"Files controls"]) {
                if ([self parseToolbarChildren:el winBounds:winBounds]) {
                    foundTb = el;
                    break;
                }
            }
        }

        if (depth < 38) {
            CFTypeRef childrenRef = NULL;
            if (AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef) == kAXErrorSuccess && childrenRef) {
                NSArray *children = (__bridge NSArray *)childrenRef;
                for (NSInteger idx = (NSInteger)children.count - 1; idx >= 0; idx--) {
                    [stack addObject:@{@"el": children[idx], @"depth": @(depth + 1)}];
                }
                CFRelease(childrenRef);
            }
        }
    }

    if (foundTb) {
        _cachedToolbar = (AXUIElementRef)CFRetain(foundTb);
        return YES;
    }

    _cachedAxValid = NO;
    return NO;
}

- (void)updateWindowPosition {
    NSArray<NSRunningApplication *> *apps = [[NSWorkspace sharedWorkspace] runningApplications];
    NSRunningApplication *claudeApp = nil;
    for (NSRunningApplication *app in apps) {
        if ([app.bundleIdentifier isEqualToString:@"com.anthropic.claudefordesktop"]) {
            claudeApp = app;
            break;
        }
    }

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

            BOOL isOnScreen = [info[(__bridge NSString *)kCGWindowIsOnscreen] boolValue];
            if (!isOnScreen) continue;

            NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
            CGFloat w = [bounds[@"Width"] doubleValue];
            CGFloat h = [bounds[@"Height"] doubleValue];
            CGFloat area = w * h;
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

    if (!found) {
        if (!_isExpanded && _panel.isVisible) [_panel orderOut:nil];
        return;
    }

    CGFloat claudeW = mainClaudeBounds.size.width;
    CGFloat anchorRightX = mainClaudeBounds.origin.x + claudeW - 196.0;
    CGFloat availableGap = MAX(100.0, claudeW - 196.0 - 450.0);
    CGFloat toolbarMidY = 22.0;

    if ([self scanClaudeHeaderViaAX:claudeApp.processIdentifier winBounds:mainClaudeBounds]) {
        anchorRightX = _cachedAxAnchorRightX;
        availableGap = _cachedAxAvailableGap;
        toolbarMidY = _cachedAxToolbarMidY;
    } else {
        [self pollLevelDbFallbackLayout];
        CGFloat sidebarW = _ldbSidebarCollapsed ? 0.0 : _ldbSidebarWidth;
        CGFloat contentW = MAX(320.0, claudeW - sidebarW);
        if (_ldbChatRatio < 0.99) {
            CGFloat chatW = contentW * _ldbChatRatio;
            CGFloat splitX = mainClaudeBounds.origin.x + sidebarW + chatW;
            anchorRightX = splitX - 196.0;
            availableGap = MAX(44.0, chatW - 196.0 - 210.0);
        } else {
            anchorRightX = mainClaudeBounds.origin.x + claudeW - 196.0;
            availableGap = MAX(80.0, contentW - 196.0 - 240.0);
        }
    }

    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    BOOL isMouseDragging = ([NSEvent pressedMouseButtons] != 0);
    BOOL isMoving = (fabs(claudeW - _lastClaudeWidth) > 0.5) || (fabs(availableGap - _lastAvailableWidth) > 0.5);
    if (isMouseDragging || isMoving) {
        _activeResizeUntil = now + 0.8;
    }
    [self adjustTimerSpeed:(now < _activeResizeUntil ? 0.033 : 0.12)];

    CGFloat primaryScreenH = NSScreen.screens[0].frame.size.height;
    CGFloat screenMinX = NSScreen.screens[0].frame.origin.x;
    for (NSScreen *scr in NSScreen.screens) {
        CGFloat topY = primaryScreenH - NSMaxY(scr.frame);
        CGRect qRect = CGRectMake(scr.frame.origin.x, topY, scr.frame.size.width, scr.frame.size.height);
        if (CGRectContainsPoint(qRect, CGPointMake(CGRectGetMidX(mainClaudeBounds), CGRectGetMidY(mainClaudeBounds)))) {
            screenMinX = scr.frame.origin.x;
            break;
        }
    }

    CGFloat targetX = anchorRightX - _currentWidth + 4.0;
    CGFloat rightInset = 0.0;
    if (_isExpanded) {
        CGFloat minAllowedX = MAX(screenMinX + 8.0, mainClaudeBounds.origin.x + 8.0);
        if (targetX < minAllowedX) {
            rightInset = minAllowedX - targetX;
            targetX = minAllowedX;
        }
    }

    if (fabs(availableGap - _lastAvailableWidth) > 1.0
        || fabs(claudeW - _lastClaudeWidth) > 1.0
        || fabs(rightInset - _lastRightInset) > 1.0) {
        _lastAvailableWidth = availableGap;
        _lastClaudeWidth = claudeW;
        _lastRightInset = rightInset;
        NSString *layoutJs = [NSString stringWithFormat:@"window.__setClaudeLayout && window.__setClaudeLayout(%.0f, %.0f, %.0f);", availableGap, claudeW, rightInset];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:layoutJs completionHandler:nil];
        });
    }

    // 垂直对齐到 Claude 顶栏按钮中线（默认 22px）
    CGFloat topPadding = MAX(1.0, toolbarMidY - (_capsuleHeight / 2.0) - 3.0);
    CGFloat targetY = primaryScreenH - (mainClaudeBounds.origin.y + topPadding + _currentHeight);

    NSRect targetFrame = NSMakeRect(targetX, targetY, _currentWidth, _currentHeight);
    if (!NSEqualRects(targetFrame, _panel.frame)) {
        [_panel setFrame:targetFrame display:YES animate:NO];
    }

    if (!_panel.isVisible) {
        [_panel orderFront:nil];
    }

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
    _lastAvailableWidth = -1.0;
    [self pollStatusFile];
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        OverlayController *controller = [[OverlayController alloc] init];
        (void)controller;
        [app run];
    }
    return 0;
}
