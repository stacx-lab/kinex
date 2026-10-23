export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
}
