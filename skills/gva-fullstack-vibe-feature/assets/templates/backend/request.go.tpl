package request

type List{{PASCAL}} struct {
	Page     int `json:"page" form:"page"`
	PageSize int `json:"pageSize" form:"pageSize"`
}

type Create{{PASCAL}} struct {
	Name string `json:"name"`
}

type Update{{PASCAL}} struct {
	ID   uint   `json:"id"`
	Name string `json:"name"`
}

type Delete{{PASCAL}} struct {
	ID uint `json:"id"`
}
