package {{MODULE}}

import "time"

type {{PASCAL}} struct {
	ID        uint      `json:"id" gorm:"primarykey"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Name      string    `json:"name" gorm:"column:name;comment:名称"`
}

func ({{PASCAL}}) TableName() string {
	return "{{SNAKE_TABLE}}"
}
