import { Avatar, Badge, Box, Card, HStack, Heading, Stack, Tag, Text } from '@chakra-ui/react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { type PublicProfile } from '@/lib/api';
import { nameInitial } from '@/lib/posts';
import { interestCategoryLabel, joinedMonthText, profileCounts } from '@/lib/profile';
import { OwnProfileLink } from './own-profile-link';

/**
 * A member's public profile (#41, ADR-0078; ADR-0069 decision 3 #37), drawn from the one public
 * answer every reader gets (`GET /profiles/:publicId`) — signed in or not, the member or not:
 *
 * - the image area: the round image the member uploaded in MY 설정 (#141, ADR-0079 — served by
 *   `GET /media/:mediaId`, a new address per upload), or the nickname's first letter while there
 *   is none — never a social login's photo (#37-6); the CURRENT nickname (#37-3) as the page's
 *   heading, '운영자' on an admin account (#45-9, #37-7: operating rights only); '2026년 10월 가입'
 *   (#37-3);
 * - the 소개, plain text with its line breaks and never a link (#37-3: «링크 없음» — it is a text
 *   node, so an address in it stays words), and nothing at all when there is none;
 * - every interest category picked (#37-5), a sub-category after its top-level one, and nothing at
 *   all — not even the label — when none is (#37-5: «안 골랐으면 표시 없음»);
 * - the counts of visible posts and comments and the likes they received (#37-4), each named for
 *   what it counts and never a score, a rank or a skill (N05 §2, D5);
 * - on the member's own profile, the link to MY 설정 (decision 4 #41, `OwnProfileLink` — decided in
 *   the browser);
 * - the posts and comments area, '준비 중' until #51 fills it (#37-14).
 *
 * Nothing else of the account is on the page or in its answer (#37-8, #37-11~13): no balance,
 * order, holding, fill, PnL, watched market, proposal, verification mark, restriction, email, real
 * name or number. No directive: the server renders it into the HTML (the page reads the answer on
 * the server); only the owner's link is a client component.
 */
export function ProfileView({ profile }: { profile: PublicProfile }) {
  const { member } = profile;
  return (
    <Stack gap="6" data-testid="profile">
      <Stack gap="5">
        <HStack gap="4" align="center" minW="0">
          <Avatar.Root size="2xl" flexShrink="0" aria-hidden="true" data-testid="profile-avatar">
            <Avatar.Fallback>{nameInitial(member.nickname)}</Avatar.Fallback>
            {member.imageUrl !== null && (
              <Avatar.Image src={member.imageUrl} alt="" data-testid="profile-avatar-image" />
            )}
          </Avatar.Root>
          <Stack gap="1" minW="0">
            <HStack gap="2" minW="0" flexWrap="wrap">
              <Heading
                as="h2"
                textStyle="headline"
                wordBreak="break-word"
                data-testid="profile-nickname"
              >
                {member.nickname}
              </Heading>
              {member.isAdmin && (
                <Badge size="sm" variant="subtle" colorPalette="gray" data-testid="profile-admin">
                  {copy.postAuthorAdmin}
                </Badge>
              )}
            </HStack>
            <Text textStyle="bodySm" color="fg.muted" data-testid="profile-joined">
              {joinedMonthText(profile.joinedMonth)}
            </Text>
          </Stack>
        </HStack>

        {profile.bio !== null && (
          <Stack as="section" aria-labelledby="profile-bio-heading" gap="1.5">
            <Heading id="profile-bio-heading" as="h3" srOnly>
              {copy.profileBio}
            </Heading>
            <Text
              textStyle="bodyMd"
              color="fg"
              whiteSpace="pre-line"
              wordBreak="break-word"
              data-testid="profile-bio"
            >
              {profile.bio}
            </Text>
          </Stack>
        )}

        {profile.interestCategories.length > 0 && (
          <Stack
            as="section"
            aria-labelledby="profile-interests-heading"
            gap="2"
            data-testid="profile-interests"
          >
            <Heading id="profile-interests-heading" as="h3" textStyle="overline" color="fg.muted">
              {copy.profileInterests}
            </Heading>
            <HStack as="ul" listStyleType="none" gap="2" flexWrap="wrap">
              {profile.interestCategories.map((category) => {
                const label = interestCategoryLabel(category);
                // A tag, as the market detail writes the same trail: never wider than the line,
                // one line cut short with the whole name in its title, so the page never scrolls
                // sideways at 375px. A name runs to 32 characters (`categories.name_ko`: the
                // seed's today, the operators' with #17), '상위 › 하위' to twice that. The item
                // may shrink below its text for it (`minW`).
                return (
                  <Box as="li" key={category.slug} minW="0" maxW="full">
                    <Tag.Root
                      size="lg"
                      variant="outline"
                      colorPalette="gray"
                      title={label}
                      data-testid={`profile-interest-${category.slug}`}
                    >
                      <Tag.Label>{label}</Tag.Label>
                    </Tag.Root>
                  </Box>
                );
              })}
            </HStack>
          </Stack>
        )}

        <HStack
          as="dl"
          gap="5"
          flexWrap="wrap"
          aria-label={copy.profileCountsLabel}
          data-testid="profile-counts"
        >
          {profileCounts(profile).map((count) => (
            <HStack key={count.key} gap="1.5" data-testid={`profile-count-${count.key}`}>
              <Text as="dt" textStyle="bodySm" color="fg.muted">
                {count.label}
              </Text>
              <Text as="dd" textStyle="emphasisMd" color="fg">
                {count.value}
              </Text>
            </HStack>
          ))}
        </HStack>

        <OwnProfileLink publicId={member.publicId} />
      </Stack>

      <Card.Root as="section" aria-labelledby="profile-posts-heading" data-testid="profile-posts">
        <Card.Header>
          <Heading id="profile-posts-heading" as="h3" size="md">
            {copy.profilePostsHeading}
          </Heading>
        </Card.Header>
        <Card.Body>
          <EmptyState message={copy.comingSoon} data-testid="profile-posts-coming-soon" />
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
