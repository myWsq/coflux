import type { CSSProperties, FormEvent, ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { USE_SUPABASE } from "@/config";

// 独立认证页自绘 body 背景（无宿主壳），结构参照官方 login 模板。
const pageStyle: CSSProperties = {
  minHeight: "100%",
  backgroundColor: "var(--color-background-body)",
  padding: "var(--spacing-6)",
};
const contentStyle: CSSProperties = {
  width: "100%",
  maxWidth: 400,
};

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <Center axis="both" style={pageStyle}>
      <VStack gap={4} hAlign="center" style={contentStyle}>
        <Text type="body" weight="bold" size="lg">
          coflux
        </Text>
        <Card padding={8} width="100%">
          {children}
        </Card>
        <Text type="body" color="secondary" size="sm">
          安全连接到你的远程工作区
        </Text>
      </VStack>
    </Center>
  );
}

type CredentialsFormProps = {
  title: string;
  description: string;
  username: string;
  password: string;
  busy: boolean;
  error?: string;
  submitLabel?: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function CredentialsForm(props: CredentialsFormProps) {
  return (
    <form onSubmit={props.onSubmit}>
      <VStack gap={4} hAlign="stretch">
        <VStack gap={1} hAlign="center">
          <Icon icon={LockKeyhole} size="md" />
          <Heading level={2}>{props.title}</Heading>
          <Text type="body" color="secondary" size="sm">
            {props.description}
          </Text>
        </VStack>

        {props.error ? <Banner status="error" title={props.error} container="card" /> : null}

        <TextInput
          label={USE_SUPABASE ? "邮箱" : "用户名"}
          type={USE_SUPABASE ? "email" : "text"}
          value={props.username}
          onChange={(value) => props.onUsernameChange(value)}
          placeholder={USE_SUPABASE ? "you@example.com" : "输入用户名"}
          htmlName="username"
          hasAutoFocus
          isDisabled={props.busy}
        />
        <TextInput
          label="密码"
          type="password"
          value={props.password}
          onChange={(value) => props.onPasswordChange(value)}
          placeholder="输入密码"
          htmlName="password"
          isDisabled={props.busy}
        />

        <Button
          label={props.busy ? "连接中…" : (props.submitLabel ?? "登录")}
          variant="primary"
          type="submit"
          isLoading={props.busy}
          isDisabled={props.busy || !props.username || !props.password}
        />
      </VStack>
    </form>
  );
}

type AuthMessageProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
};

export function AuthMessage(props: AuthMessageProps) {
  return (
    <VStack gap={2} hAlign="center">
      {props.icon}
      <Heading level={2}>{props.title}</Heading>
      {props.description ? (
        <Text type="body" color="secondary" size="sm">
          {props.description}
        </Text>
      ) : null}
      {props.children ? <VStack gap={0} hAlign="stretch">{props.children}</VStack> : null}
    </VStack>
  );
}
