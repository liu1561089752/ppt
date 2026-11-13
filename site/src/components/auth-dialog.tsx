/**
 * auth-dialog.tsx
 *
 * 登录/注册弹窗:
 * - 用 shadcn Dialog + Tabs(login/register)
 * - 登录:username + password
 * - 注册:username + password + email(可选)
 * - 表单校验:用户名 3-20 字母数字下划线,密码 6-32
 * - 成功:关闭弹窗 + toast.success + invalidate useCurrentUser
 * - 失败:toast.error 显示后端错误消息
 * - react-hook-form + zod 校验
 */
'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { apiPost } from '@/lib/api-client'
import { useAppStore, type User } from '@/store/app-store'
import { CURRENT_USER_QUERY_KEY } from '@/hooks/use-current-user'

// 用户名:3-20 字母数字下划线(与后端 register 校验一致)
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

const loginSchema = z.object({
  username: z
    .string()
    .min(1, '请输入用户名')
    .max(64, '用户名过长'),
  password: z
    .string()
    .min(1, '请输入密码')
    .max(128, '密码过长'),
})

const registerSchema = z
  .object({
    username: z
      .string()
      .regex(USERNAME_RE, '用户名只能包含字母数字下划线,长度 3-20'),
    password: z
      .string()
      .min(6, '密码长度需为 6-32')
      .max(32, '密码长度需为 6-32'),
    confirmPassword: z.string().min(1, '请再次输入密码'),
    email: z.string().email('邮箱格式不正确').optional().or(z.literal('')),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: '两次输入的密码不一致',
    path: ['confirmPassword'],
  })

type LoginFormValues = z.infer<typeof loginSchema>
type RegisterFormValues = z.infer<typeof registerSchema>

export function AuthDialog() {
  // 单独 selector 订阅,避免任意 store 变化触发重渲染
  const authDialogOpen = useAppStore((s) => s.authDialogOpen)
  const authDialogMode = useAppStore((s) => s.authDialogMode)
  const closeAuthDialog = useAppStore((s) => s.closeAuthDialog)
  const openAuthDialog = useAppStore((s) => s.openAuthDialog)
  const queryClient = useQueryClient()

  const [mode, setMode] = React.useState<'login' | 'register'>(authDialogMode)
  // 密码明文切换(M-47):登录/注册两个密码框共用一个开关状态即可(两 tab 不同时出现)
  const [showPassword, setShowPassword] = React.useState(false)

  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  })
  const registerForm = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { username: '', password: '', confirmPassword: '', email: '' },
  })

  // 跟随 store 的 mode 变化
  React.useEffect(() => {
    if (authDialogOpen) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setMode(authDialogMode)
    }
  }, [authDialogOpen, authDialogMode])

  // 打开时重置表单
  React.useEffect(() => {
    if (authDialogOpen) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setShowPassword(false)
      loginForm.reset({ username: '', password: '' })
      registerForm.reset({ username: '', password: '', confirmPassword: '', email: '' })
    }
  }, [authDialogOpen, loginForm, registerForm])

  const onLoginSubmit = async (values: LoginFormValues) => {
    try {
      const data = await apiPost<{ user: User }>('/api/auth/login', {
        username: values.username.trim(),
        password: values.password,
      })
      toast.success(`欢迎回来,${data.user.username}`)
      closeAuthDialog()
      // 立即更新本地 store,再后台刷新 me(防止 me 缓存返回旧数据)
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, data.user)
      await queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '登录失败')
    }
  }

  const onRegisterSubmit = async (values: RegisterFormValues) => {
    try {
      const email = (values.email || '').trim()
      const data = await apiPost<{ user: User }>('/api/auth/register', {
        username: values.username.trim(),
        password: values.password,
        email: email || undefined,
      })
      toast.success(`注册成功,欢迎加入 ${data.user.username}`)
      closeAuthDialog()
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, data.user)
      await queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '注册失败')
    }
  }

  const loginSubmitting = loginForm.formState.isSubmitting
  const registerSubmitting = registerForm.formState.isSubmitting

  return (
    <Dialog
      open={authDialogOpen}
      onOpenChange={(open) => {
        if (!open) closeAuthDialog()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>欢迎使用 ChatPPT</DialogTitle>
          <DialogDescription>
            登录已有账号或注册新账号,开始使用 AI 一键生成 PPT 服务
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={mode}
          onValueChange={(v) => {
            setMode(v as 'login' | 'register')
            openAuthDialog(v as 'login' | 'register')
          }}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">登录</TabsTrigger>
            <TabsTrigger value="register">注册</TabsTrigger>
          </TabsList>

          {/* 登录 Tab */}
          <TabsContent value="login" className="mt-4">
            <Form {...loginForm}>
              <form
                onSubmit={loginForm.handleSubmit(onLoginSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={loginForm.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="请输入用户名"
                          autoComplete="username"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={loginForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>密码</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showPassword ? 'text' : 'password'}
                            placeholder="请输入密码"
                            autoComplete="current-password"
                            className="pr-11"
                            {...field}
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? '隐藏密码' : '显示密码'}
                            onClick={() => setShowPassword((s) => !s)}
                            className="absolute right-0 top-0 flex h-full w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                          >
                            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={loginSubmitting}
                >
                  {loginSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      登录中…
                    </>
                  ) : (
                    '登录'
                  )}
                </Button>
              </form>
            </Form>
          </TabsContent>

          {/* 注册 Tab */}
          <TabsContent value="register" className="mt-4">
            <Form {...registerForm}>
              <form
                onSubmit={registerForm.handleSubmit(onRegisterSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={registerForm.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="3-20 位字母数字下划线"
                          autoComplete="username"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={registerForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>密码</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showPassword ? 'text' : 'password'}
                            placeholder="6-32 位"
                            autoComplete="new-password"
                            className="pr-11"
                            {...field}
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? '隐藏密码' : '显示密码'}
                            onClick={() => setShowPassword((s) => !s)}
                            className="absolute right-0 top-0 flex h-full w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                          >
                            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={registerForm.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>确认密码</FormLabel>
                      <FormControl>
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          placeholder="再次输入密码"
                          autoComplete="new-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={registerForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>邮箱(可选)</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="选填"
                          autoComplete="email"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={registerSubmitting}
                >
                  {registerSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      注册中…
                    </>
                  ) : (
                    '注册并登录'
                  )}
                </Button>
              </form>
            </Form>
          </TabsContent>
        </Tabs>

        <p className="text-xs text-muted-foreground text-center">
          注册即表示同意
          <button
            type="button"
            className="ml-1 underline underline-offset-2 hover:text-foreground"
            onClick={() => useAppStore.getState().openAgreement('agreement')}
          >
            用户协议
          </button>
        </p>
      </DialogContent>
    </Dialog>
  )
}
