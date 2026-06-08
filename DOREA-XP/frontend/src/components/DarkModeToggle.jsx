import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { MoonIcon, SunIcon } from '@phosphor-icons/react'

export default function DarkModeToggle({ buttonClassName = 'rounded-2xl h-11 w-11', iconClassName = 'size-[24px]' }) {
  const { theme, setTheme } = useTheme()

  return (
    <Button
      variant="outline"
      size="icon"
      className={buttonClassName}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
    >
      {theme === 'dark'
        ? <SunIcon className={iconClassName} weight="regular" />
        : <MoonIcon className={iconClassName} weight="regular" />}
    </Button>
  )
}
