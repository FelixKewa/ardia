import { useEffect, useState } from "react";
import { acceptWebKitReview, addWebKitHost, bindWebKitSettings, cancelWebKitReview, disableWebKitExtension, exactWebKitHost, refreshWebKitExtensions, reviewWebKitExtension, selectWebKitGrant, selectWebKitScope, useWebKitExtensionError, useWebKitExtensionList, useWebKitExtensions, useWebKitSharedApprovalsUnreadable, WEBKIT_PERMISSION_DETAILS } from "../../../state/extensions/webKit";
import { Box, Button, Checkbox, space, Text, TextField } from "../../ui";
import { FormField, Group, Row, SectionHeader } from "../Form";

export function WebKitExtensionsSection({ profileId }: { profileId: string }) {
  const list = useWebKitExtensionList(profileId);
  const error = useWebKitExtensionError(profileId);
  const sharedUnreadable = useWebKitSharedApprovalsUnreadable(profileId);
  const available = useWebKitExtensions((s) => s.available);
  const choosing = useWebKitExtensions((s) => s.choosing);
  const review = useWebKitExtensions((s) => s.review?.profileId === profileId ? s.review : null);
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setHost(""); setHostError(false); setAdvanced(false); }, [review?.key]);
  useEffect(() => {
    const unbind = bindWebKitSettings(profileId);
    void refreshWebKitExtensions(profileId);
    return unbind;
  }, [profileId]);
  return (
    <>
      <SectionHeader title="WebKit Extensions" />
      <Group>
        <Row anchor="profiles.webKitExtensions" description={available === false ? "WebKit extensions require macOS 15.4 or later." : "Load a trusted extension folder for WebKit tabs. Choose access for this profile or all regular profiles. Private windows are excluded. Reload existing WebKit tabs after loading, disabling, or changing access: previously injected scripts may remain until reload."}>
          <Button title={choosing ? "Inspecting…" : "Load Folder…"} disabled={available !== true || choosing || !!review?.busy} onPress={() => void reviewWebKitExtension(profileId)} />
        </Row>
        {list.map((extension) => (
          <Row
            key={extension.id}
            title={`${extension.name} · ${extension.version}`}
            description={[
              extension.enabled && extension.loaded
                ? `Enabled ${extension.allProfiles ? "in all regular profiles" : "in this profile"}. Sites: ${extension.allWebsites ? "All HTTP and HTTPS websites" : extension.grantedOrigins.map((origin) => origin.replace(/^https:\/\//, "").replace(/\/\*$/, "")).join(", ") || "None"}.`
                : extension.enabled ? "Not loaded." : "Disabled.",
              ...(extension.enabled && extension.allProfiles ? ["Disabling in all profiles also turns off each profile's own approval of this folder."] : []),
              ...extension.errors,
            ].join("\n")}
          >
            <Box row gap="s">
              <Button title={extension.enabled ? "Review Access…" : "Review and Enable…"} disabled={choosing || !!review?.busy} onPress={() => void reviewWebKitExtension(profileId, extension)} />
              {extension.enabled ? <Button title={extension.allProfiles ? "Disable in All Profiles" : "Disable"} disabled={!!review?.busy} onPress={() => void disableWebKitExtension(profileId, extension.id, extension.allProfiles === true)} /> : null}
            </Box>
          </Row>
        ))}
      </Group>
      {sharedUnreadable ? <Text size="caption" tone="destructive" style={NOTICE}>Ardia can’t read the approvals shared with all profiles. Shared extensions are off, and loading or changing access is blocked until that saved file is restored.</Text> : null}
      {error ? <Text size="caption" tone="destructive" style={NOTICE}>{error}</Text> : null}
      {review ? (
        <>
          <SectionHeader title={`Review ${review.pkg.name} · ${review.pkg.version}`} />
          <Group>
            <Row description="Your current access is selected. Review any changes before loading. Updated code keeps the extension’s saved data." />
          </Group>
          <FormField label="Use on all websites and profiles">
            <Checkbox value={review.allWebsites && review.allProfiles} disabled={review.busy || !review.pkg.canUseAllWebsites} onChange={(on) => void selectWebKitScope(review.key, on, on, on)} />
            <Text size="caption" tone="textSecondary" style={NOTICE}>
              {review.pkg.canUseAllWebsites ? "Each profile keeps its own settings and account. Private windows are excluded." : review.allWebsitesWithdrawn ? "This version can’t be offered for all websites. Choose websites under Individual Permissions." : "All websites is unavailable for this extension. Choose individual permissions below."}
            </Text>
          </FormField>
          <Text size="caption" tone="textSecondary" style={NOTICE}>
            {`${review.allWebsites ? "All websites" : `${review.origins.length} selected websites`} · ${review.allProfiles ? "All regular profiles" : "This profile only"}`}
          </Text>
          <Box row style={NOTICE}>
            <Button title={advanced ? "Hide Individual Permissions" : "Individual Permissions…"} onPress={() => setAdvanced(!advanced)} />
          </Box>
          {advanced ? <>
            <Text size="caption" tone="textSecondary" style={NOTICE}>{`Permissions: ${review.permissions.join(", ") || "None"}. All websites includes HTTP and HTTPS. All regular profiles includes future profiles.`}</Text>
            <FormField label="Use in all regular profiles">
              <Checkbox value={review.allProfiles} disabled={review.busy} onChange={(on) => void selectWebKitScope(review.key, review.allWebsites, on)} />
            </FormField>
            <FormField label="Allow all HTTP and HTTPS websites">
              <Checkbox value={review.allWebsites} disabled={review.busy || !review.pkg.canUseAllWebsites} onChange={(on) => void selectWebKitScope(review.key, on, review.allProfiles)} />
            </FormField>
          <Group>
            {review.pkg.requestedPermissions.map((permission) => (
              <Row key={permission} title={WEBKIT_PERMISSION_DETAILS[permission] ?? permission} description={review.pkg.supportedPermissions.includes(permission) ? permission : `${permission} is unsupported and will remain denied.`}>
                <Checkbox value={review.permissions.includes(permission)} disabled={review.busy || !review.pkg.supportedPermissions.includes(permission)} onChange={(on) => selectWebKitGrant(review.key, "permissions", permission, on)} />
              </Row>
            ))}
            {!review.allWebsites ? review.pkg.requestedOrigins.map((origin) => (
              <Row key={origin} title={origin} description={exactWebKitHost(origin) ? "Read and change all HTTPS pages on this exact host. URL paths do not limit access." : "This broad rule remains denied. Add only the exact HTTPS hosts you want to allow below."}>
                <Checkbox value={review.origins.includes(origin)} disabled={review.busy || !exactWebKitHost(origin)} onChange={(on) => selectWebKitGrant(review.key, "origins", origin, on)} />
              </Row>
            )) : null}
            {!review.allWebsites ? review.origins.filter((origin) => !review.pkg.requestedOrigins.includes(origin)).map((origin) => (
              <Row key={origin} title={origin} description="Read and change all HTTPS pages on this exact host.">
                <Checkbox value disabled={review.busy} onChange={(on) => selectWebKitGrant(review.key, "origins", origin, on)} />
              </Row>
            )) : null}
            {!review.pkg.requestedPermissions.length && !review.pkg.requestedOrigins.length ? <Row description="No special permissions requested." /> : null}
          </Group>
          {!review.allWebsites && review.pkg.requestedOrigins.length ? (
            <FormField label="Allow an exact HTTPS host">
              <Box row gap="s">
                <TextField value={host} onChangeText={setHost} placeholder="www.netflix.com" disabled={review.busy} style={{ width: 180 }} />
                <Button title="Add" disabled={review.busy || !host.trim()} onPress={() => {
                  const added = addWebKitHost(review.key, host);
                  setHostError(!added);
                  if (added) setHost("");
                }} />
              </Box>
              <Text size="caption" tone={hostError ? "destructive" : "textSecondary"} style={NOTICE}>
                {hostError ? "Enter a host covered by the extension's request, without wildcards, a port, or a page path." : "For a broad requested rule, add individual hosts. Each host must be covered by the extension's request; this is checked before the extension loads."}
              </Text>
            </FormField>
          ) : null}
          </> : null}
          {review.pkg.errors.map((message, index) => <Text key={index} size="caption" tone="textSecondary" style={NOTICE}>{message}</Text>)}
          <Box row gap="s" style={NOTICE}>
            <Button title="Cancel" disabled={review.busy} onPress={cancelWebKitReview} />
            <Button title={review.inspecting ? "Inspecting…" : review.busy ? "Loading…" : "Review and Load…"} kind="primary" disabled={review.busy} onPress={() => void acceptWebKitReview(review.key)} />
          </Box>
        </>
      ) : null}
    </>
  );
}

const NOTICE = { marginTop: space.m } as const;
