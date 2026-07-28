import { useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { LockKeyhole } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { CofluxClient } from "@coflux/client";

/** 登录页（同 apps/web 的 auth-shell.tsx 结构，收窄给单栏手机视口）。 */
export function AuthScreen({ client }: { client: CofluxClient }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const authState = useStore(client.store, (state) => state.authState);
  const loginError = useStore(client.store, (state) => state.loginError);
  const busy = authState === "authenticating";

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await client.login(username, password);
  }

  return (
    <Center axis="both" minHeight="100%" style={{ backgroundColor: "var(--color-background)", padding: "var(--spacing-4, 16px)" }}>
      <VStack gap={4} hAlign="center" style={{ width: "100%", maxWidth: 380 }}>
        <Text type="body" weight="bold" size="lg">
          coflux
        </Text>
        <Card padding={8} width="100%">
          <form onSubmit={login}>
            <VStack gap={4} hAlign="stretch">
              <VStack gap={1} hAlign="center">
                <Icon icon={LockKeyhole} size="md" />
                <Heading level={2}>登录到 coflux</Heading>
                <Text type="body" color="secondary" size="sm">
                  使用你的账号访问远程工作区
                </Text>
              </VStack>

              {authState === "auth-failed" ? <Banner status="error" title={loginError || "登录失败"} container="card" /> : null}

              <TextInput
                label="账号"
                type="text"
                value={username}
                onChange={setUsername}
                placeholder="输入账号"
                htmlName="username"
                isDisabled={busy}
              />
              <TextInput
                label="密码"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="输入密码"
                htmlName="password"
                isDisabled={busy}
              />

              <Button
                label={busy ? "连接中…" : "登录"}
                variant="primary"
                type="submit"
                isLoading={busy}
                isDisabled={busy || !username || !password}
              />
            </VStack>
          </form>
        </Card>
        <Text type="body" color="secondary" size="sm">
          安全连接到你的远程工作区
        </Text>
      </VStack>
    </Center>
  );
}
