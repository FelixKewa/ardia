import {
  getDisplayMediaSources,
  type DisplayMediaAudio,
  type DisplayMediaSource,
  answerDisplayMedia,
  askForScreenRecording,
  noteScreenRecordingMissing,
  screenRecordingAllowed,
  shareableTabs,
  shareTab,
} from "../../state/media/screenShare";
import { runningAppIcon } from "../../state/app/system";
import { Symbol, Button, Checkbox, MenuRow, PANEL, Popover, POPOVER_MARGIN, Text, useHover, usePopoverPresenceOf } from "../ui";
import { PromptHeader } from "../site/PromptParts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Image, Pressable, ScrollView, View, type TextStyle } from "react-native";
import { useTheme } from "../ui/theme";
import { concentric, radius, space } from "../ui/tokens";
import { useMediaTokens } from "./tokens";
import { Favicon } from "../favicon/Favicon";
import { useMedia } from "../../state/media/media";
import { originForSecurityDisplay } from "../../lib/url";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";

const WIDTH = 460;
const REFRESH_MS = 2500;
const TAB = "tab:";
const AUDIO_SHARED_BY_DEFAULT = { tab: true, screen: false, window: false };

type SourceKind = keyof typeof AUDIO_SHARED_BY_DEFAULT;

const audioLabel = (kind: SourceKind, audio: DisplayMediaAudio) =>
  kind === "tab" ? "Also share tab audio" : kind === "window" && audio.window === "application" ? "Also share application audio" : "Also share system audio";

const audioOffered = (kind: SourceKind | null, audio: DisplayMediaAudio | null) =>
  !!audio && (kind === "tab" ? audio.tab : kind === "screen" ? audio.screen : kind === "window" ? !!audio.window : false);

export function SharePicker({ tabId, paneWidth }: { tabId: string; paneWidth: number }) {
  const { shown: request, closing, onClosed } = usePopoverPresenceOf(useMedia((m) => m.displayRequests[tabId]) ?? null);
  const [sources, setSources] = useState<DisplayMediaSource[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shareAudio, setShareAudio] = useState(AUDIO_SHARED_BY_DEFAULT);
  const [icons, setIcons] = useState<Record<number, string | null>>({});
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  const list = useRef<ScrollView>(null);

  useEffect(() => {
    if (!request || closing) return;
    setSources(request.sources);
    setSelected(null);
    setShareAudio(AUDIO_SHARED_BY_DEFAULT);
    setScreenAccess(null);
    let live = true;
    void screenRecordingAllowed().then((allowed) => {
      if (!live) return;
      setScreenAccess(allowed);
      if (!allowed) noteScreenRecordingMissing();
    });
    const t = setInterval(() => {
      void getDisplayMediaSources().then((next) => live && setSources(next));
      void screenRecordingAllowed().then((allowed) => live && setScreenAccess(allowed));
    }, REFRESH_MS);
    const focusList = setTimeout(() => (list.current as unknown as { focus?: () => void } | null)?.focus?.(), 50);
    return () => {
      live = false;
      clearInterval(t);
      clearTimeout(focusList);
    };
  }, [request?.id, closing]);

  useEffect(() => {
    const missing = [...new Set(sources.map((s) => s.pid).filter((pid): pid is number => pid !== undefined && !(pid in icons)))];
    if (!missing.length) return;
    void Promise.all(missing.map(async (pid) => [pid, await runningAppIcon(pid, 20)] as const)).then((entries) =>
      setIcons((current) => ({ ...current, ...Object.fromEntries(entries) })),
    );
  }, [sources]);

  if (!request) return null;
  const tabs = shareableTabs(tabId);
  const screens = screenAccess ? sources.filter((s) => s.kind === "screen") : [];
  const windows = screenAccess ? sources.filter((s) => s.kind === "window") : [];
  const isTab = (id: string | null) => !!id && id.startsWith(TAB) && tabs.some((t) => TAB + t.id === id);
  const offered = [...screens, ...windows];
  const kindOf = (id: string | null): SourceKind | null => (isTab(id) ? "tab" : (offered.find((s) => s.id === id)?.kind ?? null));
  const valid = !!kindOf(selected);
  const selectedKind = kindOf(selected);
  const audioFor = (kind: SourceKind | null) => !!kind && audioOffered(kind, request.audio) && shareAudio[kind];
  const share = (id: string | null = selected) => {
    const kind = kindOf(id);
    if (!id || !kind) return;
    if (kind === "tab") return void shareTab(tabId, id.slice(TAB.length), audioFor(kind));
    answerDisplayMedia(tabId, id, audioFor(kind));
  };
  const cancel = () => answerDisplayMedia(tabId, null);
  const frameHost = request.frameOrigin ? originForSecurityDisplay(request.frameOrigin) : "";
  const receiver = frameHost && frameHost !== originForSecurityDisplay(request.origin) ? `${frameHost}, a frame on this page,` : "The site";
  const width = Math.min(WIDTH, paneWidth - 24);

  return (
    <Popover key={request.id} width={width} top={POPOVER_MARGIN} left={(paneWidth - width) / 2} onDismiss={cancel} closing={closing} onClosed={onClosed}>
      <View style={{ paddingBottom: PANEL.inset }}>
        <View style={HEADER}>
          <PromptHeader
            icons={["rectangle.inset.filled.and.person.filled"]}
            title={`Share your screen with ${originForSecurityDisplay(request.origin)}`}
            message={
              audioFor(selectedKind)
                ? `${receiver} will see and hear what you choose.`
                : request.audio && !request.audio.screen && !request.audio.window && selectedKind !== "tab"
                  ? `${receiver} will see what you choose. Only tabs share their audio.`
                  : `${receiver} will see what you choose.`
            }
          />
        </View>

        <ScrollView
          ref={list}
          focusable
          enableFocusRing={false}
          keyDownEvents={[{ key: "Escape" }, { key: "Enter" }]}
          onKeyDown={closing ? undefined : (e) => (e.nativeEvent.key === "Escape" ? cancel() : share())}
          style={{ maxHeight: 340, marginTop: space.xs }}
        >
          {tabs.length ? (
            <>
              <SectionTitle title="Tabs" />
              {tabs.map((t) => (
                <SourceRow
                  key={t.id}
                  leading={<Favicon url={t.url} />}
                  title={t.title || t.url}
                  detail={t.id === tabId ? "This Tab" : null}
                  selected={TAB + t.id === selected}
                  onSelect={() => setSelected(TAB + t.id)}
                  onShare={() => share(TAB + t.id)}
                />
              ))}
            </>
          ) : null}
          {screens.length ? (
            <>
              <SectionTitle title={screens.length === 1 ? "Screen" : "Screens"} />
              <View style={SCREEN_GRID}>
                {screens.map((s) => (
                  <ScreenTile key={s.id} source={s} width={(width - 2 * PANEL.rowInset - space.m) / 2} selected={s.id === selected} onSelect={() => setSelected(s.id)} onShare={() => share(s.id)} />
                ))}
              </View>
            </>
          ) : null}
          {windows.length ? (
            <>
              <SectionTitle title="Windows" />
              {windows.map((s) => (
                <WindowRow key={s.id} source={s} icon={s.pid !== undefined ? icons[s.pid] : null} selected={s.id === selected} onSelect={() => setSelected(s.id)} onShare={() => share(s.id)} />
              ))}
            </>
          ) : null}
          {screenAccess === false ? (
            <>
              <SectionTitle title="Screens and Windows" />
              <ScreenRecordingNeeded />
            </>
          ) : null}
          {screenAccess !== false && !screens.length && !windows.length && !tabs.length ? <Text size="small" tone="textSecondary" style={EMPTY}>Nothing can be shared right now.</Text> : null}
        </ScrollView>

        <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: PANEL.inset, marginTop: space.l }}>
          {selectedKind && request.audio && audioOffered(selectedKind, request.audio) ? (
            <Checkbox
              value={shareAudio[selectedKind]}
              onChange={(on) => setShareAudio((current) => ({ ...current, [selectedKind]: on }))}
              label={audioLabel(selectedKind, request.audio)}
            />
          ) : null}
          <View style={{ flex: 1 }} />
          <Button variant="pill" title="Cancel" onPress={cancel} />
          <Button variant="pill" title="Share" primary disabled={!valid} onPress={() => share()} />
        </View>
      </View>
    </Popover>
  );
}

const EMPTY = { padding: space.l, textAlign: "center" } as const;
const SCREEN_GRID = { flexDirection: "row", flexWrap: "wrap", gap: space.m, paddingHorizontal: PANEL.rowInset } as const;
const HEADER = { paddingHorizontal: PANEL.inset, paddingTop: PANEL.inset } as const;
const NOTICE = { paddingHorizontal: PANEL.inset, paddingBottom: space.s, gap: space.xs, alignItems: "flex-start" } as const;

function ScreenRecordingNeeded() {
  return (
    <View style={NOTICE}>
      <Text size="small" tone="textSecondary">
        To share a window or your entire screen, turn on Ardia in System Settings › Privacy & Security › Screen Recording, then quit and reopen Ardia.
      </Text>
      <Button variant="text" look="link" title="Open System Settings" onPress={() => void askForScreenRecording()} />
    </View>
  );
}
const SECTION_TITLE = { paddingHorizontal: PANEL.inset, marginTop: space.s, marginBottom: space.s } as const;

function SectionTitle({ title }: { title: string }) {
  return (
    <Text size="caption" weight="semibold" tone="textSecondary" style={SECTION_TITLE}>
      {title}
    </Text>
  );
}

function ScreenTile({ source, width, selected, onSelect, onShare }: { source: DisplayMediaSource; width: number; selected: boolean; onSelect(): void; onShare(): void }) {
  const theme = useTheme();
  const tokens = useMediaTokens();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(true, buttonMotion.iconPressScale);
  const iconScaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const aspect = source.width && source.height ? source.height / source.width : 10 / 16;
  const previewWidth = width - 2 * space.m;
  return (
    <View {...hoverProps} onDoubleClick={onShare}>
      <Pressable onPress={onSelect} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut}>
        <View style={{ width, padding: space.m, borderRadius: radius.panel, alignItems: "center", backgroundColor: selected ? theme.rowSelected : hovered ? theme.rowHover : undefined }}>
          <View
            style={{
              width: previewWidth,
              height: Math.min(previewWidth * aspect, 80),
              borderRadius: concentric(radius.panel, space.m),
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? theme.accent : theme.chipBorder,
              backgroundColor: tokens.previewFill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Animated.View pointerEvents="none" style={iconScaleStyle}>
              <Symbol name="display" size={22} color={theme.textSecondary} style={{ width: 30, height: 30 }} />
            </Animated.View>
          </View>
          <Text lines={1} size="small" style={TILE_NAME}>
            {source.name}
          </Text>
          {source.width ? (
            <Text lines={1} size="tiny" tone="textTertiary" style={TILE_RESOLUTION}>
              {source.width} × {source.height}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

const TILE_NAME = { marginTop: space.s } as const;
const TILE_RESOLUTION: TextStyle = { fontVariant: ["tabular-nums"] };
const ROW_DETAIL = { flexShrink: 1 } as const;

function WindowRow({ source, icon, selected, onSelect, onShare }: { source: DisplayMediaSource; icon: string | null | undefined; selected: boolean; onSelect(): void; onShare(): void }) {
  const theme = useTheme();
  const title = source.name || source.app || "Window";
  const app = source.app && source.app !== title ? source.app : null;
  return (
    <SourceRow
      leading={icon ? <Image source={{ uri: icon }} style={{ width: 20, height: 20 }} /> : <Symbol name="macwindow" size={14} color={theme.textSecondary} style={{ width: 20, height: 20 }} />}
      title={title}
      detail={app}
      detailShrinks
      selected={selected}
      onSelect={onSelect}
      onShare={onShare}
    />
  );
}

function SourceRow({
  leading,
  title,
  detail,
  detailShrinks,
  selected,
  onSelect,
  onShare,
}: {
  leading: ReactNode;
  title: string;
  detail: string | null;
  detailShrinks?: boolean;
  selected: boolean;
  onSelect(): void;
  onShare(): void;
}) {
  return (
    <View onDoubleClick={onShare}>
      <MenuRow
        checked={selected}
        leading={leading}
        title={title}
        onPress={onSelect}
        accessory={
          detail ? (
            <Text lines={1} size="caption" tone="textSecondary" style={detailShrinks ? ROW_DETAIL : undefined}>
              {detail}
            </Text>
          ) : null
        }
      />
    </View>
  );
}
