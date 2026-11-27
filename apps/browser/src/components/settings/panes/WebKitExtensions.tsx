import { useEffect, useState } from "react";
import { acceptWebKitReview, addWebKitHost, bindWebKitSettings, cancelWebKitReview, disableWebKitExtension, exactWebKitHost, refreshWebKitExtensions, reviewWebKitExtension, selectWebKitGrant, useWebKitExtensionError, useWebKitExtensionList, useWebKitExtensions, WEBKIT_PERMISSION_DETAILS } from "../../../state/extensions/webKit";
import { Box, Button, Checkbox, space, Text, TextField } from "../../ui";
import { FormField, Group, Row, SectionHeader } from "../Form";

export function WebKitExtensionsSection({ profileId }: { profileId: string }) {
  const list = useWebKitExtensionList(profileId);
  const error = useWebKitExtensionError(profileId);
  const available = useWebKitExtensions((s) => s.available);
  const choosing = useWebKitExtensions((s) => s.choosing);
  const review = useWebKitExtensions((s) => s.review?.profileId === profileId ? s.review : null);
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState(false);
  useEffect(() => { setHost(""); setHostError(false); }, [review?.key]);
  useEffect(() => {
    const unbind = bindWebKitSettings(profileId);
    void refreshWebKitExtensions(profileId);
    return unbind;
  }, [profileId]);
  return (
    <>
      <SectionHeader title="WebKit Extensions" />
      <Group>
        <Row anchor="profiles.webKitExtensions" description={available === false ? "WebKit extensions require macOS 15.4 or later." : "Load a trusted extension folder for this profile's WebKit tabs. Private windows are excluded. Loading an extension again reloads the open pages it runs on. After disabling one, reload its pages yourself: injected scripts remain until then."}>
          <Button title={choosing ? "Inspecting…" : "Load Folder…"} disabled={available !== true || choosing || !!review?.busy} onPress={() => void reviewWebKitExtension(profileId)} />
        </Row>
        {list.map((extension) => (
          <Row
            key={extension.id}
            title={`${extension.name} · ${extension.version}`}
            description={[
              extension.enabled && extension.loaded
                ? `Enabled. Sites: ${extension.grantedOrigins.map((origin) => origin.replace(/^https:\/\//, "").replace(/\/\*$/, "")).join(", ") || "None"}.`
                : extension.enabled ? "Not loaded." : "Disabled.",
              ...extension.errors,
            ].join("\n")}
          >
            <Box row gap="s">
              <Button title={extension.enabled ? "Review Access…" : "Review and Enable…"} disabled={choosing || !!review?.busy} onPress={() => void reviewWebKitExtension(profileId, extension.path)} />
              {extension.enabled ? <Button title="Disable" onPress={() => void disableWebKitExtension(profileId, extension.id)} /> : null}
            </Box>
          </Row>
        ))}
      </Group>
      {error ? <Text size="caption" tone="destructive" style={NOTICE}>{error}</Text> : null}
      {review ? (
        <>
          <SectionHeader title={`Review ${review.pkg.name} · ${review.pkg.version}`} />
          <Group>
            <Row description="Loading runs extension code, including background code. Updated code keeps its existing extension data. Choose only the access you want to allow, then review the trust confirmation." />
            {review.pkg.requestedPermissions.map((permission) => (
              <Row key={permission} title={WEBKIT_PERMISSION_DETAILS[permission] ?? permission} description={review.pkg.supportedPermissions.includes(permission) ? permission : `${permission} is unsupported and will remain denied.`}>
                <Checkbox value={review.permissions.includes(permission)} disabled={review.busy || !review.pkg.supportedPermissions.includes(permission)} onChange={(on) => selectWebKitGrant(review.key, "permissions", permission, on)} />
              </Row>
            ))}
            {review.pkg.requestedOrigins.map((origin) => (
              <Row key={origin} title={origin} description={exactWebKitHost(origin) ? "Read and change all HTTPS pages on this exact host. URL paths do not limit access." : "This broad rule remains denied. Add only the exact HTTPS hosts you want to allow below."}>
                <Checkbox value={review.origins.includes(origin)} disabled={review.busy || !exactWebKitHost(origin)} onChange={(on) => selectWebKitGrant(review.key, "origins", origin, on)} />
              </Row>
            ))}
            {review.origins.filter((origin) => !review.pkg.requestedOrigins.includes(origin)).map((origin) => (
              <Row key={origin} title={origin} description="Read and change all HTTPS pages on this exact host.">
                <Checkbox value disabled={review.busy} onChange={(on) => selectWebKitGrant(review.key, "origins", origin, on)} />
              </Row>
            ))}
            {!review.pkg.requestedPermissions.length && !review.pkg.requestedOrigins.length ? <Row description="No special permissions requested." /> : null}
          </Group>
          {review.pkg.requestedOrigins.length ? (
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
          {review.pkg.errors.map((message, index) => <Text key={index} size="caption" tone="textSecondary" style={NOTICE}>{message}</Text>)}
          <Box row gap="s" style={NOTICE}>
            <Button title="Cancel" disabled={review.busy} onPress={cancelWebKitReview} />
            <Button title={review.busy ? "Loading…" : "Review and Load…"} kind="primary" disabled={review.busy} onPress={() => void acceptWebKitReview(review.key)} />
          </Box>
        </>
      ) : null}
    </>
  );
}

const NOTICE = { marginTop: space.m } as const;
