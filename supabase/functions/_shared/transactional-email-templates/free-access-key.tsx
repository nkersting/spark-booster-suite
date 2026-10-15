import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
  Section,
  Link,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

interface Props {
  code?: string
  appBaseUrl?: string
}

const Email = ({ code = 'FREE-XXXX-XXXX', appBaseUrl = 'https://presentation.ironactionai.com' }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your DynamicTree free access key</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Welcome to DynamicTree</Heading>
        <Text style={text}>
          Here is your free access key. It includes 3 sessions to try out the app.
        </Text>
        <Section style={codeBox}>
          <Text style={codeText}>{code}</Text>
        </Section>
        <Text style={text}>
          Open the app and paste your key on the access screen:
        </Text>
        <Text style={text}>
          <Link href={appBaseUrl} style={link}>{appBaseUrl}</Link>
        </Text>
        <Text style={muted}>
          Keep this email — you'll need the key each time you sign in.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: 'Your DynamicTree free access key',
  displayName: 'Free Access Key',
  previewData: { code: 'FREE-ABCD-1234', appBaseUrl: 'https://presentation.ironactionai.com' },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif', color: '#0f172a' }
const container = { padding: '32px 28px', maxWidth: '560px' }
const h1 = { fontSize: '22px', fontWeight: 600, margin: '0 0 16px' }
const text = { fontSize: '15px', lineHeight: '22px', margin: '0 0 14px' }
const muted = { fontSize: '13px', lineHeight: '20px', color: '#64748b', margin: '24px 0 0' }
const codeBox = { background: '#0f172a', borderRadius: '8px', padding: '18px 20px', margin: '18px 0' }
const codeText = { color: '#7dd3fc', fontFamily: 'monospace', fontSize: '20px', letterSpacing: '2px', margin: 0, textAlign: 'center' as const }
const link = { color: '#2563eb' }